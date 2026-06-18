/**
 * `serveStdio` — the stdio entry point for serving the 2026-07-28 protocol
 * revision on a long-lived connection, with 2025-era serving as the default
 * for clients that open with the `initialize` handshake.
 *
 * The entry owns the stdio transport and the era decision for the connection.
 * It classifies the connection's opening exchange exactly once (using the
 * same body-primary rules as the HTTP entry), constructs ONE server instance
 * from the consumer's factory for the era the client opened with, pins that
 * instance for the lifetime of the connection, and passes every later message
 * straight through to it. No per-message era classification ever runs after
 * the connection is pinned — exactly mirroring how `createMcpHandler`
 * classifies an HTTP request before any instance exists.
 *
 * The opening exchange:
 *
 * - An `initialize` request (or any claim-less message) opens a 2025-era
 *   session: the factory builds a legacy instance and the connection is
 *   pinned to it (`legacy: 'serve'`, the default). With `legacy: 'reject'`
 *   the opening is answered with the unsupported-protocol-version error
 *   naming the supported modern revisions instead.
 * - A request carrying a valid per-request `_meta` envelope naming a
 *   supported modern revision pins the connection to a modern instance
 *   (era-marked and given the modern-only handlers, exactly like the HTTP
 *   entry's modern path).
 * - A `server/discover` probe is answered by an optimistically built modern
 *   instance but does NOT pin the connection yet: the spec's stdio
 *   backward-compatibility flow lets a client probe first and then either
 *   continue with modern requests (which pins the connection modern) or fall
 *   back to the `initialize` handshake when no mutually supported modern
 *   revision exists — in which case the probe instance is discarded and a
 *   fresh legacy instance serves the handshake.
 * - Once the modern era is pinned, a later claim-less `initialize` is
 *   rejected with the unsupported-protocol-version error naming the supported
 *   revisions (the spec recommends naming them in any error returned to
 *   `initialize`, and forbids falling back once the modern era is confirmed).
 *
 * Every instance the factory produces serves exactly one era; the ambiguity
 * of the opening exchange lives entirely in this entry. In the probe-fallback
 * case the factory is called twice (once for the discarded probe instance,
 * once for the legacy instance), so factories should be cheap and
 * side-effect-free to construct — the same expectation `createMcpHandler`
 * already sets for per-request construction.
 *
 * Hand-constructed servers connected directly to a `StdioServerTransport`
 * are unaffected by this entry: they keep serving the 2025-era protocol they
 * were written for.
 */
import type {
    CancelledNotificationParams,
    JSONRPCMessage,
    JSONRPCNotification,
    JSONRPCRequest,
    MessageClassification,
    MessageExtraInfo,
    RequestId,
    Transport,
    TransportSendOptions
} from '@modelcontextprotocol/core';
import {
    carriesValidModernEnvelopeClaim,
    envelopeClaimVersion,
    hasEnvelopeClaim,
    isJSONRPCErrorResponse,
    isJSONRPCNotification,
    isJSONRPCRequest,
    isJSONRPCResultResponse,
    modernOnlyStrictRejection,
    ProtocolErrorCode,
    requestMetaOf,
    setNegotiatedProtocolVersion,
    SUPPORTED_MODERN_PROTOCOL_VERSIONS,
    UnsupportedProtocolVersionError,
    validateEnvelopeMeta
} from '@modelcontextprotocol/core';

import type { McpServerFactory } from './createMcpHandler.js';
import { DEFAULT_MAX_SUBSCRIPTIONS, StdioListenRouter } from './listenRouter.js';
import { McpServer } from './mcp.js';
import type { Server } from './server.js';
import { installModernOnlyHandlers } from './server.js';
import { StdioServerTransport } from './stdio.js';

/** Options for {@linkcode serveStdio}. */
export interface ServeStdioOptions {
    /**
     * How a 2025-era opening (an `initialize` request, or any claim-less
     * message) is handled:
     *
     * - `'serve'` (default) — the connection is pinned to a 2025-era instance
     *   from the same factory and served exactly as a hand-wired stdio server
     *   serves it today.
     * - `'reject'` — the opening request is answered with the
     *   unsupported-protocol-version error naming the supported modern
     *   revisions (claim-less notifications are dropped); the connection
     *   stays open for a modern opening.
     */
    legacy?: 'serve' | 'reject';
    /**
     * Bring your own transport (for example a `StdioServerTransport`
     * constructed over a Unix domain socket or TCP stream, per the stdio
     * binding's custom-transport guidance). Defaults to a
     * {@linkcode StdioServerTransport} over the current process's stdio. The
     * entry owns the transport: it starts it, receives every inbound message,
     * and closes it when the connection ends.
     */
    transport?: Transport;
    /** Callback for out-of-band errors (reporting only; it never alters what is written to the wire). */
    onerror?: (error: Error) => void;
    /**
     * Reject a new `subscriptions/listen` with `-32603` 'Subscription limit
     * reached' (in-band, before the ack) when this many subscriptions are
     * already open on this connection.
     * @default 1024
     */
    maxSubscriptions?: number;
}

/** The handle returned by {@linkcode serveStdio}. */
export interface StdioServerHandle {
    /** Tears the connection down: closes the pinned instance (if any) and the underlying transport. */
    close(): Promise<void>;
}

/* ------------------------------------------------------------------------ *
 * Per-instance channel
 * ------------------------------------------------------------------------ */

/**
 * How long the probe-discard path waits for the probe instance to answer the
 * requests it was delivered before closing it. The wait normally settles as
 * soon as the DiscoverResult is handed to the wire (or immediately, when a
 * delivered cancellation already settled the probe); the bound is a backstop
 * so no edge can ever hold the connection's inbound pump indefinitely behind
 * the discard.
 */
const DISCARD_ANSWER_TIMEOUT_MS = 3000;

/**
 * The transport a pinned instance is connected to: a thin channel that writes
 * through to the entry-owned wire transport and receives the messages the
 * entry forwards. The wire transport itself is never handed to an instance —
 * that is what lets the entry discard an optimistic probe instance (close the
 * channel) without tearing down the connection.
 */
class StdioConnectionChannel implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;

    private _closed = false;
    /** Request ids the entry delivered to the instance that the instance has not yet answered. */
    private readonly _pendingRequests = new Set<RequestId>();
    private _drainWaiters: Array<() => void> = [];

    constructor(
        private readonly _wire: Transport,
        private readonly _onInstanceClose: () => void,
        /**
         * Optional first-look on outbound messages. When set and returning
         * `'handled'`, the channel does not write the message to the wire
         * (the entry already wrote whatever was appropriate). Used by the
         * modern-era listen router to fan a change notification out onto the
         * active subscriptions instead of broadcasting it unsolicited.
         */
        private readonly _outboundIntercept?: (message: JSONRPCMessage) => 'handled' | undefined
    ) {}

    async start(): Promise<void> {
        // The entry already started the wire transport; connecting an
        // instance to its channel must not start anything again.
    }

    async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
        if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
            // The instance answered a delivered request: settle it whether or
            // not the wire write below succeeds (write failures surface
            // through the wire's own error reporting).
            const { id } = message;
            if (id !== undefined) {
                this._settle(id);
            }
        }
        if (this._closed) {
            // A discarded or torn-down instance has nowhere to write; late
            // sends are dropped.
            return;
        }
        if (this._outboundIntercept?.(message) === 'handled') {
            return;
        }
        return this._wire.send(message, options);
    }

    setProtocolVersion = (version: string): void => {
        this._wire.setProtocolVersion?.(version);
    };

    /** Forwards one inbound message to the connected instance. */
    deliver(message: JSONRPCMessage, extra?: MessageExtraInfo): void {
        if (this._closed) {
            return;
        }
        if (isJSONRPCRequest(message)) {
            this._pendingRequests.add(message.id);
        } else if (isJSONRPCNotification(message) && message.method === 'notifications/cancelled') {
            // By protocol contract a cancelled request may legitimately go
            // unanswered (the instance aborts the in-flight handler and writes
            // nothing for it), so a delivered cancellation settles the request
            // it names: nothing should keep waiting for an answer that may
            // never come. Non-cancelled requests still settle only when their
            // answer is handed to the wire.
            const cancelledId = (message.params as CancelledNotificationParams | undefined)?.requestId;
            if (cancelledId !== undefined) {
                this._settle(cancelledId);
            }
        }
        this.onmessage?.(message, extra);
    }

    /**
     * Resolves once every request delivered to the instance has been answered
     * through {@linkcode send}, settled by a delivered cancellation, or the
     * channel has been closed and nothing further can be answered. The wait is
     * bounded by `timeoutMs` as a backstop so no edge can hold the caller
     * indefinitely; resolves `false` only when the bound elapsed with requests
     * still unanswered. Used by the probe-discard path so a probe request the
     * entry accepted is never silently dropped.
     */
    async whenRequestsAnswered(timeoutMs: number): Promise<boolean> {
        if (this._closed || this._pendingRequests.size === 0) {
            return true;
        }
        return await new Promise<boolean>(resolve => {
            const waiter = (): void => {
                clearTimeout(timer);
                resolve(true);
            };
            const timer = setTimeout(() => {
                this._drainWaiters = this._drainWaiters.filter(pending => pending !== waiter);
                resolve(false);
            }, timeoutMs);
            this._drainWaiters.push(waiter);
        });
    }

    async close(): Promise<void> {
        if (this._closed) {
            return;
        }
        this._closed = true;
        // Nothing further can be answered through a closed channel; release
        // anyone waiting on in-flight answers.
        this._pendingRequests.clear();
        this._releaseDrainWaiters();
        try {
            this._onInstanceClose();
        } finally {
            this.onclose?.();
        }
    }

    private _settle(id: RequestId): void {
        this._pendingRequests.delete(id);
        if (this._pendingRequests.size === 0) {
            this._releaseDrainWaiters();
        }
    }

    private _releaseDrainWaiters(): void {
        const waiters = this._drainWaiters;
        this._drainWaiters = [];
        for (const waiter of waiters) {
            waiter();
        }
    }
}

/* ------------------------------------------------------------------------ *
 * Opening-exchange classification
 * ------------------------------------------------------------------------ */

interface EnvelopeIssue {
    key: string;
    problem: string;
}

type OpeningClassification =
    /** A 2025-era opening: `initialize`, or any message without an envelope claim. */
    | { kind: 'legacy'; reason: 'initialize' | 'no-claim'; requestedVersion?: string }
    /** A valid envelope claim naming a modern revision this entry serves. */
    | { kind: 'modern'; revision: string; classification: MessageClassification }
    /** A present envelope claim whose envelope is malformed. */
    | { kind: 'invalid-envelope'; issue: EnvelopeIssue }
    /** A valid envelope claim naming a revision this entry does not serve (unknown future or 2025-era). */
    | { kind: 'unsupported-revision'; requested: string };

/**
 * Classifies one message of the opening exchange with the same body-primary
 * rules the HTTP entry applies per request: `initialize` is the legacy
 * handshake unless it carries a valid modern envelope claim; a present claim
 * is validated (never silently ignored); a claim-less message is 2025-era
 * traffic. There is no header layer on stdio, so the body is the only signal.
 */
function classifyOpeningMessage(message: JSONRPCRequest | JSONRPCNotification): OpeningClassification {
    const params = message.params;

    if (message.method === 'initialize' && !carriesValidModernEnvelopeClaim(params)) {
        const requestedVersion =
            params !== null && typeof params === 'object' && typeof (params as { protocolVersion?: unknown }).protocolVersion === 'string'
                ? ((params as { protocolVersion: string }).protocolVersion as string)
                : undefined;
        return { kind: 'legacy', reason: 'initialize', ...(requestedVersion !== undefined && { requestedVersion }) };
    }

    if (!hasEnvelopeClaim(params)) {
        return { kind: 'legacy', reason: 'no-claim' };
    }

    // A present claim is validated, never silently ignored — a malformed
    // envelope behind the claim is an invalid-params answer, not a fall back
    // to legacy serving (mirrors the HTTP entry's envelope rung).
    const meta = requestMetaOf(params);
    const issues = meta === undefined ? [] : validateEnvelopeMeta(meta);
    const firstIssue = issues[0];
    if (firstIssue !== undefined) {
        return { kind: 'invalid-envelope', issue: firstIssue };
    }

    const claimedVersion = envelopeClaimVersion(params);
    if (claimedVersion === undefined || !SUPPORTED_MODERN_PROTOCOL_VERSIONS.includes(claimedVersion)) {
        // The claim names a revision this entry does not serve (an unknown
        // future revision, or a 2025-era revision delivered via the envelope
        // mechanism) — answered like the HTTP entry's modern path.
        return { kind: 'unsupported-revision', requested: claimedVersion ?? 'unknown' };
    }

    return { kind: 'modern', revision: claimedVersion, classification: { era: 'modern', revision: claimedVersion } };
}

/* ------------------------------------------------------------------------ *
 * The entry
 * ------------------------------------------------------------------------ */

interface ConnectedInstance {
    product: McpServer | Server;
    channel: StdioConnectionChannel;
}

type EntryState =
    /** Waiting for the connection's opening message. */
    | { phase: 'opening' }
    /** A `server/discover` probe was answered; the era is not pinned yet. */
    | { phase: 'probe'; instance: ConnectedInstance }
    /** The connection is pinned to one instance serving one era. */
    | { phase: 'pinned'; era: 'legacy' | 'modern'; instance: ConnectedInstance }
    | { phase: 'closed' };

/**
 * Serves MCP over stdio from a server factory, owning the era decision for
 * the connection: the opening exchange selects the era, ONE instance from the
 * factory is pinned for the connection lifetime, and everything after passes
 * straight through to it. See the module documentation for the opening rules.
 *
 * ```ts
 * import { serveStdio } from '@modelcontextprotocol/server/stdio';
 *
 * serveStdio(() => {
 *     const server = new McpServer({ name: 'my-server', version: '1.0.0' }, { capabilities: { tools: {} } });
 *     // register tools/resources/prompts once — the same factory serves both eras
 *     return server;
 * });
 * ```
 */
export function serveStdio(factory: McpServerFactory, options: ServeStdioOptions = {}): StdioServerHandle {
    const legacyMode = options.legacy ?? 'serve';
    const wire = options.transport ?? new StdioServerTransport();

    let state: EntryState = { phase: 'opening' };
    /** Channel currently being discarded (its close must not tear the connection down). */
    let discarding: StdioConnectionChannel | undefined;
    let closing = false;

    /**
     * Whether the connection has been torn down (`handle.close()` or the wire
     * closing). The opening arms re-check this after every await: a close can
     * race factory construction, and the continuation must neither resurrect
     * the connection state nor keep a late-resolved instance around.
     */
    const isTornDown = (): boolean => closing || state.phase === 'closed';

    const reportError = (error: Error) => {
        try {
            options.onerror?.(error);
        } catch {
            // Reporting must never affect the wire.
        }
    };

    const writeErrorResponse = (id: RequestId, code: number, message: string, data?: unknown): Promise<void> =>
        wire
            .send({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined && { data }) } })
            .catch(error => reportError(toError(error)));

    /**
     * Entry-handled `subscriptions/listen` for this connection: holds the
     * active subscriptions, serves inbound listen / cancelled-of-listen
     * before the pinned instance is consulted, and rewrites the instance's
     * outbound change notifications onto the active subscriptions. Only
     * consulted on a modern-pinned connection — on a legacy connection
     * change notifications pass straight through (the 2025 unsolicited
     * delivery model is unchanged).
     */
    const listenRouter = new StdioListenRouter(options.maxSubscriptions ?? DEFAULT_MAX_SUBSCRIPTIONS);

    /** Outbound intercept installed on a modern instance's channel. */
    const modernOutboundIntercept = (message: JSONRPCMessage): 'handled' | undefined => {
        if (!isJSONRPCNotification(message)) return undefined;
        const routed = listenRouter.routeOutbound(message);
        if (routed === 'passthrough') return undefined;
        // A subscription-gated change notification on the modern era: one
        // stamped copy per subscription that opted in (an empty array means
        // it is dropped — the modern era never delivers an un-requested
        // change type unsolicited). Nothing else from the instance is
        // affected.
        for (const stamped of routed) {
            void wire.send({ jsonrpc: '2.0', ...stamped }).catch(error => reportError(toError(error)));
        }
        return 'handled';
    };

    /**
     * Entry-handled inbound listen routing for a modern-pinned connection.
     * Returns `true` when the message was served at the entry and must NOT
     * be delivered to the pinned instance.
     */
    const tryServeListen = async (message: JSONRPCMessage): Promise<boolean> => {
        if (isJSONRPCRequest(message) && message.method === 'subscriptions/listen') {
            // Entry-handled listen is its own request-handling subsystem; it
            // applies the same per-request envelope rung the instance's
            // `_onrequest` would (method-existence is N/A here — the entry
            // recognized the method — so envelope validation is the first
            // applicable rung) and the same supported-revision check the
            // opening classifier and the HTTP entry apply per request. Reuses
            // the same validators the opening classifier uses.
            const meta = requestMetaOf(message.params);
            const issue = hasEnvelopeClaim(message.params)
                ? (meta === undefined ? [] : validateEnvelopeMeta(meta))[0]
                : { key: '_meta', problem: 'the per-request envelope is required on protocol revision 2026-07-28' };
            const claimedVersion = envelopeClaimVersion(message.params);
            let reply;
            if (issue !== undefined) {
                reply = {
                    jsonrpc: '2.0' as const,
                    id: message.id,
                    error: { code: -32_602, message: `Invalid _meta envelope: ${issue.key}: ${issue.problem}` }
                };
            } else if (claimedVersion === undefined || !SUPPORTED_MODERN_PROTOCOL_VERSIONS.includes(claimedVersion)) {
                const error = new UnsupportedProtocolVersionError({
                    supported: [...SUPPORTED_MODERN_PROTOCOL_VERSIONS],
                    requested: claimedVersion ?? 'unknown'
                });
                reply = { jsonrpc: '2.0' as const, id: message.id, error: { code: error.code, message: error.message, data: error.data } };
            } else {
                reply = listenRouter.serve(message);
            }
            await wire
                .send('error' in reply ? reply : { jsonrpc: '2.0', method: reply.method, params: reply.params })
                .catch(error => reportError(toError(error)));
            return true;
        }
        if (isJSONRPCNotification(message) && message.method === 'notifications/cancelled') {
            const cancelledId = (message.params as CancelledNotificationParams | undefined)?.requestId;
            // Inbound cancel of a parked listen: tear the subscription down
            // and DO NOT deliver to the instance (it never saw the listen
            // request). After this point nothing further is delivered for
            // that subscription id (post-cancel hardening).
            if (cancelledId !== undefined && listenRouter.cancel(cancelledId)) {
                return true;
            }
        }
        return false;
    };

    /** Answers a 2025-era request the entry will not serve (the modern-only rejection cells). */
    const answerLegacyRejection = (
        request: JSONRPCRequest,
        reason: 'initialize' | 'no-claim',
        requestedVersion?: string
    ): Promise<void> => {
        const rejection = modernOnlyStrictRejection(
            { kind: 'legacy', reason, ...(requestedVersion !== undefined && { requestedVersion }) },
            SUPPORTED_MODERN_PROTOCOL_VERSIONS
        );
        if (rejection === undefined) {
            return Promise.resolve();
        }
        reportError(new Error(`Rejected 2025-era request on a modern-only stdio connection (${rejection.cell}): ${rejection.message}`));
        return writeErrorResponse(request.id, rejection.code, rejection.message, rejection.data);
    };

    const onInstanceClosed = (channel: StdioConnectionChannel) => {
        if (closing || channel === discarding) {
            return;
        }
        // The pinned (or probe) instance was closed from the instance side:
        // the connection is over.
        void closeAll();
    };

    const connectInstance = async (era: 'legacy' | 'modern', revision?: string): Promise<ConnectedInstance> => {
        const product = await factory({ era });
        const server = product instanceof McpServer ? product.server : product;
        if (era === 'modern') {
            // Era-write at instance binding, then modern-only handler
            // installation — the same helpers the HTTP entry's modern path
            // uses, before the instance is connected.
            setNegotiatedProtocolVersion(server, revision);
            installModernOnlyHandlers(server, SUPPORTED_MODERN_PROTOCOL_VERSIONS);
            // The listen router was created before this instance existed; now
            // that capabilities are known, hand them over so the acknowledged
            // filter is narrowed against what the server actually advertises.
            listenRouter.setServerCapabilities(server.getCapabilities());
        }
        const channel: StdioConnectionChannel = new StdioConnectionChannel(
            wire,
            () => onInstanceClosed(channel),
            era === 'modern' ? modernOutboundIntercept : undefined
        );
        await product.connect(channel);
        return { product, channel };
    };

    /** Closes an instance whose factory resolved only after the connection was torn down. */
    const disposeLateInstance = (instance: ConnectedInstance): Promise<void> =>
        instance.product.close().catch(error => reportError(toError(error)));

    const discardProbeInstance = async (instance: ConnectedInstance): Promise<void> => {
        // The probe instance served only the discover exchange; closing its
        // channel must not tear down the connection the fallback is about to
        // continue on.
        discarding = instance.channel;
        try {
            // A probe request the entry accepted must never go silently
            // unanswered: a client may pipeline its fallback `initialize`
            // straight behind `server/discover` without waiting, and closing
            // the instance aborts whatever it still has in flight. Let the
            // in-flight DiscoverResult reach the wire before the instance is
            // closed; the probe instance only ever receives `server/discover`,
            // whose entry-installed handler always answers promptly. A probe
            // the client cancelled is already settled by the delivered
            // cancellation (a cancelled request may go unanswered), and the
            // wait is bounded as a backstop so nothing can wedge the
            // connection's pump behind the discard.
            const answered = await instance.channel.whenRequestsAnswered(DISCARD_ANSWER_TIMEOUT_MS);
            if (!answered) {
                reportError(
                    new Error(
                        `Discarded the probe instance with requests still unanswered after ${DISCARD_ANSWER_TIMEOUT_MS}ms; continuing with the fallback`
                    )
                );
            }
            await instance.product.close();
        } catch (error) {
            reportError(toError(error));
        } finally {
            discarding = undefined;
        }
    };

    const processMessage = async (message: JSONRPCMessage): Promise<void> => {
        if (state.phase === 'closed') {
            return;
        }

        if (state.phase === 'pinned') {
            if (
                state.era === 'modern' &&
                isJSONRPCRequest(message) &&
                message.method === 'initialize' &&
                !carriesValidModernEnvelopeClaim(message.params)
            ) {
                // The modern era is confirmed for this connection; a late
                // legacy handshake is answered with the version error naming
                // the supported revisions (the specification recommends
                // naming them in any error returned to `initialize`, and
                // rules out falling back once the modern era is confirmed).
                const requestedVersion =
                    message.params !== null &&
                    typeof message.params === 'object' &&
                    typeof (message.params as { protocolVersion?: unknown }).protocolVersion === 'string'
                        ? ((message.params as { protocolVersion: string }).protocolVersion as string)
                        : undefined;
                await answerLegacyRejection(message, 'initialize', requestedVersion);
                return;
            }
            if (state.era === 'modern' && (await tryServeListen(message))) {
                return;
            }
            state.instance.channel.deliver(message);
            return;
        }

        // Negotiation window ('opening' | 'probe').
        if (!isJSONRPCRequest(message) && !isJSONRPCNotification(message)) {
            // A JSON-RPC response before any era is pinned: nothing has been
            // asked of the client yet, so there is nothing it can answer.
            reportError(new Error('Discarded a JSON-RPC response received before the connection negotiated an era'));
            return;
        }

        const opening = classifyOpeningMessage(message);
        switch (opening.kind) {
            case 'invalid-envelope': {
                const detail = `Invalid _meta envelope for protocol revision 2026-07-28: ${opening.issue.key}: ${opening.issue.problem}`;
                if (isJSONRPCRequest(message)) {
                    await writeErrorResponse(message.id, ProtocolErrorCode.InvalidParams, detail, { envelope: opening.issue });
                } else {
                    reportError(new Error(`Discarded a notification with a malformed envelope: ${detail}`));
                }
                return;
            }
            case 'unsupported-revision': {
                if (isJSONRPCRequest(message)) {
                    const error = new UnsupportedProtocolVersionError({
                        supported: [...SUPPORTED_MODERN_PROTOCOL_VERSIONS],
                        requested: opening.requested
                    });
                    reportError(error);
                    await writeErrorResponse(message.id, error.code, error.message, error.data);
                } else {
                    reportError(new Error(`Discarded a notification claiming unsupported protocol revision ${opening.requested}`));
                }
                return;
            }
            case 'modern': {
                if (isJSONRPCRequest(message) && message.method === 'server/discover') {
                    if (state.phase === 'probe') {
                        // A repeated probe is answered by the same optimistic
                        // instance and the negotiation window stays open: only
                        // a non-discover enveloped request commits the
                        // connection to the modern era, so a later fallback
                        // `initialize` is still served by a fresh legacy
                        // instance.
                        state.instance.channel.deliver(message, { classification: opening.classification });
                        return;
                    }
                    // Probe: answer from an optimistically built modern
                    // instance so the advertisement reflects the real server
                    // definition, but do not pin the connection yet — the
                    // client may still fall back to `initialize` when it
                    // shares no modern revision with the advertisement.
                    const instance = await connectInstance('modern', opening.revision);
                    if (isTornDown()) {
                        // The connection was torn down while the factory was
                        // building the probe instance: dispose of it and stay
                        // closed instead of resurrecting the negotiation
                        // window; nothing is delivered or answered.
                        await disposeLateInstance(instance);
                        return;
                    }
                    state = { phase: 'probe', instance };
                    instance.channel.deliver(message, { classification: opening.classification });
                    return;
                }
                if (state.phase === 'probe') {
                    if (isJSONRPCNotification(message)) {
                        // An enveloped notification during the negotiation
                        // window (for example a notifications/cancelled for
                        // the probe itself) is delivered to the probe instance
                        // without committing the era: only a non-discover
                        // enveloped request pins the connection, so a later
                        // fallback `initialize` is still served by a fresh
                        // legacy instance.
                        state.instance.channel.deliver(message, { classification: opening.classification });
                        return;
                    }
                    // The probe was followed by a modern request: the client
                    // committed to the modern era — pin the probe instance.
                    state = { phase: 'pinned', era: 'modern', instance: state.instance };
                } else {
                    const instance = await connectInstance('modern', opening.revision);
                    if (isTornDown()) {
                        // Closed while the factory was building the modern
                        // instance: dispose of it and stay closed.
                        await disposeLateInstance(instance);
                        return;
                    }
                    state = { phase: 'pinned', era: 'modern', instance };
                }
                if (await tryServeListen(message)) {
                    return;
                }
                state.instance.channel.deliver(message, { classification: opening.classification });
                return;
            }
            case 'legacy': {
                if (legacyMode === 'reject') {
                    if (isJSONRPCRequest(message)) {
                        await answerLegacyRejection(message, opening.reason, opening.requestedVersion);
                    }
                    // Claim-less notifications are accepted and dropped (the
                    // stdio analog of the HTTP entry's 202-and-drop); the
                    // connection stays open for a modern opening.
                    return;
                }
                if (state.phase === 'probe') {
                    // Probe-then-fallback: the client probed, found no
                    // mutually supported modern revision, and fell back to
                    // the 2025 handshake on the same connection. The probe
                    // instance is discarded; a fresh legacy instance serves
                    // the handshake.
                    await discardProbeInstance(state.instance);
                    if (isTornDown()) {
                        // Closed while the probe was being discarded: stay closed.
                        return;
                    }
                    state = { phase: 'opening' };
                }
                const instance = await connectInstance('legacy');
                if (isTornDown()) {
                    // Closed while the factory was building the legacy
                    // instance: dispose of it and stay closed.
                    await disposeLateInstance(instance);
                    return;
                }
                state = { phase: 'pinned', era: 'legacy', instance };
                state.instance.channel.deliver(message);
                return;
            }
        }
    };

    // Inbound messages are processed strictly in arrival order: the queue
    // absorbs anything that arrives while the opening exchange is still being
    // decided (factory construction and instance connection are async).
    const queue: JSONRPCMessage[] = [];
    let pumping = false;
    const pump = async (): Promise<void> => {
        if (pumping) {
            return;
        }
        pumping = true;
        try {
            while (queue.length > 0) {
                const message = queue.shift()!;
                try {
                    await processMessage(message);
                } catch (error) {
                    // Every arm of processMessage that answers a request does
                    // so through writeErrorResponse (which never throws — wire
                    // failures are routed to onerror) and returns right after,
                    // so an error escaping to here means the request was never
                    // answered. Answer it now: a throwing factory or a failed
                    // connect during the opening exchange must not leave the
                    // client's request hanging (the stdio analog of the HTTP
                    // entry's internal-server-error response). Notifications
                    // carry no id to answer and are only reported.
                    if (isJSONRPCRequest(message)) {
                        await writeErrorResponse(message.id, ProtocolErrorCode.InternalError, 'Internal server error');
                    }
                    reportError(toError(error));
                }
            }
        } finally {
            pumping = false;
        }
    };

    const closeAll = async (): Promise<void> => {
        if (closing || state.phase === 'closed') {
            return;
        }
        closing = true;
        const current = state;
        state = { phase: 'closed' };
        // Stdio server-side teardown: emit ONE `notifications/cancelled` per
        // active listen subscription referencing the listen request id (the
        // spec MUST), before the wire is closed.
        for (const cancelled of listenRouter.teardownAll()) {
            await wire.send(cancelled).catch(error => reportError(toError(error)));
        }
        if (current.phase === 'probe' || current.phase === 'pinned') {
            await current.instance.product.close().catch(error => reportError(toError(error)));
        }
        await wire.close().catch(error => reportError(toError(error)));
    };

    wire.onmessage = (message: JSONRPCMessage) => {
        queue.push(message);
        void pump();
    };
    wire.onerror = error => {
        reportError(error);
        if (state.phase === 'probe' || state.phase === 'pinned') {
            state.instance.channel.onerror?.(error);
        }
    };
    wire.onclose = () => {
        if (closing || state.phase === 'closed') {
            return;
        }
        closing = true;
        const current = state;
        state = { phase: 'closed' };
        if (current.phase === 'probe' || current.phase === 'pinned') {
            void current.instance.product.close().catch(error => reportError(toError(error)));
        }
    };

    const started = wire.start().catch(error => {
        reportError(toError(error));
        throw error;
    });
    // Surface a failed start through onerror (above); close() still resolves.
    started.catch(() => {});

    return {
        close: async () => {
            await started.catch(() => {});
            await closeAll();
        }
    };
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}
