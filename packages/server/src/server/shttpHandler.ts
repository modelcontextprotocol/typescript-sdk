import type {
    AuthInfo,
    JSONRPCErrorResponse,
    JSONRPCMessage,
    JSONRPCNotification,
    JSONRPCRequest,
    JSONRPCResultResponse,
    MessageExtraInfo,
    RequestEnv
} from '@modelcontextprotocol/core';
import {
    DEFAULT_NEGOTIATED_PROTOCOL_VERSION,
    isInitializeRequest,
    isJSONRPCErrorResponse,
    isJSONRPCNotification,
    isJSONRPCRequest,
    isJSONRPCResultResponse,
    JSONRPCMessageSchema,
    SUPPORTED_PROTOCOL_VERSIONS
} from '@modelcontextprotocol/core';

import type { BackchannelCompat } from './backchannelCompat.js';
import type { SessionCompat } from './sessionCompat.js';
import type { EventId, EventStore } from './streamableHttp.js';

/**
 * Callback bundle {@linkcode shttpHandler} uses to route inbound messages.
 */
export interface ShttpCallbacks {
    /** Called per inbound JSON-RPC request; yields notifications then one terminal response. */
    onrequest?: ((request: JSONRPCRequest, env?: RequestEnv) => AsyncIterable<JSONRPCMessage>) | undefined;
    /** Called per inbound JSON-RPC notification. */
    onnotification?: (notification: JSONRPCNotification) => void | Promise<void>;
    /** Called per inbound JSON-RPC response (client POSTing back to a server-initiated request). Returns `true` if claimed. */
    onresponse?: (response: JSONRPCResultResponse | JSONRPCErrorResponse) => boolean;
}

/**
 * Options for {@linkcode shttpHandler}.
 */
export interface ShttpHandlerOptions {
    /**
     * If `true`, return a single `application/json` response instead of an SSE stream.
     * Progress notifications yielded by handlers are dropped in this mode.
     *
     * @default false
     */
    enableJsonResponse?: boolean;

    /**
     * Pre-2026-06 session compatibility. When provided, the handler validates the
     * `mcp-session-id` header, mints a session on `initialize`, and supports the
     * standalone GET subscription stream and DELETE session termination. When omitted,
     * the handler is stateless: GET/DELETE return 405.
     */
    session?: SessionCompat;

    /**
     * Pre-2026-06 server-to-client request backchannel. When provided alongside `session`,
     * a handler's `ctx.mcpReq.send` (e.g. `elicitInput`, `requestSampling`) writes the
     * outbound request onto the open POST's SSE stream and the client's POSTed-back
     * response resolves the awaited promise. When omitted, `ctx.mcpReq.send` rejects
     * with `NotConnected` on this path.
     */
    backchannel?: BackchannelCompat;

    /**
     * Event store for SSE resumability via `Last-Event-ID`. When configured, every
     * outgoing SSE event is persisted and a priming event is sent at stream start.
     */
    eventStore?: EventStore;

    /**
     * Retry interval in milliseconds, sent in the SSE `retry` field of priming events.
     */
    retryInterval?: number;

    /**
     * Protocol versions accepted in the `mcp-protocol-version` header.
     *
     * @default {@linkcode SUPPORTED_PROTOCOL_VERSIONS}
     */
    supportedProtocolVersions?: string[];

    /** Called for non-fatal errors (validation failures, stream write errors). */
    onerror?: (error: Error) => void;
}

/**
 * Per-request extras passed alongside the web `Request`.
 */
export interface ShttpRequestExtra {
    /** Pre-parsed body (e.g. from `express.json()`). When omitted, `req.json()` is used. */
    parsedBody?: unknown;
    /** Validated auth token info from upstream middleware. */
    authInfo?: AuthInfo;
}

/**
 * RequestEnv augmented with the {@linkcode MessageExtraInfo} slot Protocol's
 * `buildContext` adapter reads to populate `ctx.http.{req, closeSSE, closeStandaloneSSE}`.
 *
 * @internal
 */
type ShttpRequestEnv = RequestEnv & { _transportExtra?: MessageExtraInfo };

function jsonError(status: number, code: number, message: string, extra?: { headers?: Record<string, string>; data?: string }): Response {
    const error: { code: number; message: string; data?: string } = { code, message };
    if (extra?.data !== undefined) error.data = extra.data;
    return Response.json(
        { jsonrpc: '2.0', error, id: null },
        { status, headers: { 'Content-Type': 'application/json', ...extra?.headers } }
    );
}

function writeSSEEvent(
    controller: ReadableStreamDefaultController<Uint8Array>,
    encoder: InstanceType<typeof TextEncoder>,
    message: JSONRPCMessage,
    eventId?: string
): boolean {
    try {
        let data = 'event: message\n';
        if (eventId) data += `id: ${eventId}\n`;
        data += `data: ${JSON.stringify(message)}\n\n`;
        controller.enqueue(encoder.encode(data));
        return true;
    } catch {
        return false;
    }
}

/** Compound key for {@linkcode shttpHandler}'s in-flight abort map: `(sessionId, requestId)`. */
function abortKey(sessionId: string | undefined, id: JSONRPCRequest['id']): string {
    return `${sessionId ?? ''}\u0000${String(id)}`;
}

/**
 * EventStore stream-ID prefix for the standalone GET stream (matches v1 `_standaloneSseStreamId`).
 * Suffixed with the session ID so each session's standalone-stream events are isolated in the
 * event store and the replay ownership check is meaningful.
 */
const STANDALONE_STREAM_ID_PREFIX = '_GET_stream';
function standaloneStreamId(sessionId: string): string {
    return `${STANDALONE_STREAM_ID_PREFIX}:${sessionId}`;
}

const SSE_HEADERS: Record<string, string> = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive'
};

/**
 * Creates a Web-standard `(Request) => Promise<Response>` handler for the MCP Streamable HTTP
 * transport, driven by {@linkcode ShttpCallbacks.onrequest} per request.
 *
 * No `_streamMapping`, `_requestToStreamMapping`, or `relatedRequestId` routing — the response
 * stream is in lexical scope of the request that opened it. Session lifecycle (when enabled)
 * lives in the supplied {@linkcode SessionCompat}, not on this handler.
 *
 * @internal Use `handleHttp` for the public entry point.
 */
export function shttpHandler(
    cb: ShttpCallbacks,
    options: ShttpHandlerOptions = {}
): (req: Request, extra?: ShttpRequestExtra) => Promise<Response> {
    const enableJsonResponse = options.enableJsonResponse ?? false;
    const session = options.session;
    const backchannel = options.backchannel;
    const eventStore = options.eventStore;
    const retryInterval = options.retryInterval;
    const supportedProtocolVersions = options.supportedProtocolVersions ?? SUPPORTED_PROTOCOL_VERSIONS;
    const onerror = options.onerror;

    /**
     * Per-request abort controllers for `notifications/cancelled`. Keyed by
     * `(sessionId, requestId)` so concurrent sessions reusing the same JSON-RPC id don't collide.
     * In stateless mode the session component is empty; cross-POST cancellation is best-effort
     * (matches v1, which required per-request transport instances in stateless mode).
     */
    const inflightAborts = new Map<string, AbortController>();

    function validateProtocolVersion(req: Request): Response | undefined {
        const v = req.headers.get('mcp-protocol-version');
        if (v !== null && !supportedProtocolVersions.includes(v)) {
            const msg = `Bad Request: Unsupported protocol version: ${v} (supported versions: ${supportedProtocolVersions.join(', ')})`;
            onerror?.(new Error(msg));
            return jsonError(400, -32_000, msg);
        }
        return undefined;
    }

    async function writePrimingEvent(
        controller: ReadableStreamDefaultController<Uint8Array>,
        encoder: InstanceType<typeof TextEncoder>,
        streamId: string,
        protocolVersion: string
    ): Promise<void> {
        if (!eventStore) return;
        if (protocolVersion < '2025-11-25') return;
        const primingId = await eventStore.storeEvent(streamId, {} as JSONRPCMessage);
        const retry = retryInterval === undefined ? '' : `retry: ${retryInterval}\n`;
        controller.enqueue(encoder.encode(`id: ${primingId}\n${retry}data: \n\n`));
    }

    async function emit(
        controller: ReadableStreamDefaultController<Uint8Array>,
        encoder: InstanceType<typeof TextEncoder>,
        streamId: string,
        message: JSONRPCMessage
    ): Promise<void> {
        const eventId = eventStore ? await eventStore.storeEvent(streamId, message) : undefined;
        if (!writeSSEEvent(controller, encoder, message, eventId)) {
            onerror?.(new Error('Failed to write SSE event'));
        }
    }

    async function handlePost(req: Request, extra?: ShttpRequestExtra): Promise<Response> {
        const accept = req.headers.get('accept');
        if (!accept?.includes('application/json') || !accept.includes('text/event-stream')) {
            onerror?.(new Error('Not Acceptable: Client must accept both application/json and text/event-stream'));
            return jsonError(406, -32_000, 'Not Acceptable: Client must accept both application/json and text/event-stream');
        }

        const ct = req.headers.get('content-type');
        if (!ct?.includes('application/json')) {
            onerror?.(new Error('Unsupported Media Type: Content-Type must be application/json'));
            return jsonError(415, -32_000, 'Unsupported Media Type: Content-Type must be application/json');
        }

        let raw: unknown;
        if (extra?.parsedBody === undefined) {
            try {
                raw = await req.json();
            } catch (error) {
                onerror?.(error as Error);
                return jsonError(400, -32_700, 'Parse error: Invalid JSON');
            }
        } else {
            raw = extra.parsedBody;
        }

        const isBatch = Array.isArray(raw);
        let messages: JSONRPCMessage[];
        try {
            messages = isBatch ? (raw as unknown[]).map(m => JSONRPCMessageSchema.parse(m)) : [JSONRPCMessageSchema.parse(raw)];
        } catch (error) {
            onerror?.(error as Error);
            return jsonError(400, -32_700, 'Parse error: Invalid JSON-RPC message');
        }

        let sessionId: string | undefined;
        let isInitialize = false;
        if (session) {
            const v = await session.validate(req, messages);
            if (!v.ok) return v.response;
            sessionId = v.sessionId;
            isInitialize = v.isInitialize;
        }
        if (!isInitialize) {
            const protoErr = validateProtocolVersion(req);
            if (protoErr) return protoErr;
        }

        const requests = messages.filter(m => isJSONRPCRequest(m));
        const notifications = messages.filter(m => isJSONRPCNotification(m));
        const responses = messages.filter(
            (m): m is JSONRPCResultResponse | JSONRPCErrorResponse => isJSONRPCResultResponse(m) || isJSONRPCErrorResponse(m)
        );

        // Register abort controllers up-front so a `notifications/cancelled` in the same batch
        // (or arriving on a concurrent POST before dispatch starts) can find them.
        const ctrls = new Map<string, AbortController>();
        for (const r of requests) {
            const key = abortKey(sessionId, r.id);
            const ctrl = new AbortController();
            ctrls.set(key, ctrl);
            inflightAborts.set(key, ctrl);
        }

        for (const n of notifications) {
            if (n.method === 'notifications/cancelled') {
                const requestId = (n.params as { requestId?: JSONRPCRequest['id'] } | undefined)?.requestId;
                if (requestId !== undefined) {
                    inflightAborts.get(abortKey(sessionId, requestId))?.abort((n.params as { reason?: string } | undefined)?.reason);
                }
            }
            void Promise.resolve(cb.onnotification?.(n)).catch(error => onerror?.(error as Error));
        }

        for (const r of responses) {
            const claimed = backchannel && sessionId !== undefined && backchannel.handleResponse(sessionId, r);
            if (!claimed) cb.onresponse?.(r);
        }

        if (requests.length === 0) {
            return new Response(null, { status: 202 });
        }

        if (!cb.onrequest) {
            return jsonError(500, -32_603, 'Handler not wired — pass an onrequest callback.');
        }
        const onrequest = cb.onrequest;

        const initReq = messages.find(m => isInitializeRequest(m));
        const initParams = initReq && isInitializeRequest(initReq) ? initReq.params : undefined;
        const clientProtocolVersion =
            initParams?.protocolVersion ?? req.headers.get('mcp-protocol-version') ?? DEFAULT_NEGOTIATED_PROTOCOL_VERSION;

        const baseEnv: ShttpRequestEnv = {
            authInfo: extra?.authInfo,
            httpReq: req,
            sessionId
        };

        if (enableJsonResponse) {
            const perReq = await Promise.all(
                requests.map(async r => {
                    const key = abortKey(sessionId, r.id);
                    const ctrl = ctrls.get(key)!;
                    const collected: JSONRPCMessage[] = [];
                    try {
                        for await (const msg of onrequest(r, { ...baseEnv, signal: ctrl.signal })) {
                            if ((isJSONRPCResultResponse(msg) || isJSONRPCErrorResponse(msg)) && !ctrl.signal.aborted) {
                                collected.push(msg);
                            }
                        }
                    } finally {
                        if (inflightAborts.get(key) === ctrl) inflightAborts.delete(key);
                    }
                    return collected;
                })
            );
            const out = perReq.flat();
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            if (sessionId !== undefined) headers['mcp-session-id'] = sessionId;
            // JSON-RPC 2.0: batch input MUST yield an array response, even if it has one entry.
            const body = !isBatch && out.length === 1 ? out[0] : out;
            return Response.json(body, { status: 200, headers });
        }

        const streamId = crypto.randomUUID();
        if (session && sessionId !== undefined) session.addStreamId(sessionId, streamId);
        const encoder = new TextEncoder();
        const headers: Record<string, string> = { ...SSE_HEADERS };
        if (sessionId !== undefined) headers['mcp-session-id'] = sessionId;

        const readable = new ReadableStream<Uint8Array>({
            start: controller => {
                const closeStream = () => {
                    try {
                        controller.close();
                    } catch {
                        // Already closed.
                    }
                };
                const supportsPolling = eventStore !== undefined && clientProtocolVersion >= '2025-11-25';
                const transportExtra: MessageExtraInfo = {
                    request: req,
                    authInfo: extra?.authInfo,
                    closeSSEStream: supportsPolling ? closeStream : undefined,
                    closeStandaloneSSEStream:
                        supportsPolling && sessionId !== undefined ? () => session?.closeStandaloneStream(sessionId) : undefined
                };
                // Backchannel writes go straight to writeSSEEvent (synchronous boolean) so a closed
                // stream surfaces as `false` immediately instead of hanging until the timeout.
                const writeSSE = (msg: JSONRPCMessage): boolean => writeSSEEvent(controller, encoder, msg);
                const env: ShttpRequestEnv = {
                    ...baseEnv,
                    _transportExtra: transportExtra,
                    ...(backchannel && sessionId !== undefined ? { send: backchannel.makeEnvSend(sessionId, writeSSE) } : {})
                };
                void (async () => {
                    try {
                        await writePrimingEvent(controller, encoder, streamId, clientProtocolVersion);
                        await Promise.all(
                            requests.map(async r => {
                                const key = abortKey(sessionId, r.id);
                                const ctrl = ctrls.get(key)!;
                                try {
                                    for await (const msg of onrequest(r, { ...env, signal: ctrl.signal })) {
                                        if ((isJSONRPCResultResponse(msg) || isJSONRPCErrorResponse(msg)) && ctrl.signal.aborted) {
                                            continue;
                                        }
                                        await emit(controller, encoder, streamId, msg);
                                    }
                                } catch (error) {
                                    onerror?.(error as Error);
                                }
                            })
                        );
                    } catch (error) {
                        onerror?.(error as Error);
                    } finally {
                        for (const [key, ctrl] of ctrls) {
                            if (inflightAborts.get(key) === ctrl) inflightAborts.delete(key);
                        }
                        try {
                            controller.close();
                        } catch {
                            // Already closed.
                        }
                    }
                })();
            },
            cancel: () => {
                for (const [key, ctrl] of ctrls) {
                    ctrl.abort(new Error('Client closed SSE stream'));
                    if (inflightAborts.get(key) === ctrl) inflightAborts.delete(key);
                }
                // streamId stays in session.streamIds so the client can resume via Last-Event-ID;
                // the bounded set in addStreamId caps growth.
            }
        });

        return new Response(readable, { status: 200, headers });
    }

    async function handleGet(req: Request): Promise<Response> {
        if (!session) {
            return jsonError(405, -32_000, 'Method Not Allowed: stateless handler does not support GET stream', {
                headers: { Allow: 'POST' }
            });
        }

        const accept = req.headers.get('accept');
        if (!accept?.includes('text/event-stream')) {
            onerror?.(new Error('Not Acceptable: Client must accept text/event-stream'));
            return jsonError(406, -32_000, 'Not Acceptable: Client must accept text/event-stream');
        }

        const v = session.validateHeader(req);
        if (!v.ok) return v.response;
        const sessionId = v.sessionId!;
        const protoErr = validateProtocolVersion(req);
        if (protoErr) return protoErr;

        if (eventStore) {
            const lastEventId = req.headers.get('last-event-id');
            if (lastEventId) {
                return replayEvents(lastEventId, sessionId, session, eventStore);
            }
        }

        if (session.hasStandaloneStream(sessionId)) {
            onerror?.(new Error('Conflict: Only one SSE stream is allowed per session'));
            return jsonError(409, -32_000, 'Conflict: Only one SSE stream is allowed per session');
        }

        const streamId = standaloneStreamId(sessionId);
        session.addStreamId(sessionId, streamId);
        const clientProtocolVersion = req.headers.get('mcp-protocol-version') ?? DEFAULT_NEGOTIATED_PROTOCOL_VERSION;
        const encoder = new TextEncoder();
        const headers: Record<string, string> = { ...SSE_HEADERS, 'mcp-session-id': sessionId };
        let registeredController: ReadableStreamDefaultController<Uint8Array> | undefined;
        const readable = new ReadableStream<Uint8Array>({
            start: controller => {
                registeredController = controller;
                session.setStandaloneStream(sessionId, controller);
                void writePrimingEvent(controller, encoder, streamId, clientProtocolVersion).catch(error => onerror?.(error as Error));
            },
            cancel: () => {
                if (registeredController) session.clearStandaloneStream(sessionId, registeredController);
            }
        });
        return new Response(readable, { headers });
    }

    async function replayEvents(lastEventId: string, sessionId: string, session: SessionCompat, eventStore: EventStore): Promise<Response> {
        if (!eventStore.getStreamIdForEventId) {
            return jsonError(
                403,
                -32_000,
                'Forbidden: event store does not support session-scoped replay (getStreamIdForEventId required)'
            );
        }
        const eventStreamId = await eventStore.getStreamIdForEventId(lastEventId);
        if (eventStreamId === undefined) {
            return jsonError(404, -32_001, 'Event not found');
        }
        if (!session.ownsStreamId(sessionId, eventStreamId)) {
            return jsonError(403, -32_000, 'Forbidden: event ID does not belong to this session');
        }
        // Only resuming the standalone GET stream takes over the session's standalone slot;
        // resuming a per-POST stream is replay-only (the POST that owned it has finished).
        const isStandaloneReplay = eventStreamId === standaloneStreamId(sessionId);

        const encoder = new TextEncoder();
        const headers: Record<string, string> = { ...SSE_HEADERS, 'mcp-session-id': sessionId };
        let registeredController: ReadableStreamDefaultController<Uint8Array> | undefined;
        let cancelled = false;
        const readable = new ReadableStream<Uint8Array>({
            start: controller => {
                if (isStandaloneReplay) {
                    // Claim synchronously so a concurrent GET hits the 409 path during replay.
                    registeredController = controller;
                    session.setStandaloneStream(sessionId, controller);
                    session.addStreamId(sessionId, eventStreamId);
                }
                void (async () => {
                    let failed = false;
                    try {
                        await eventStore.replayEventsAfter(lastEventId, {
                            send: async (eventId: EventId, message: JSONRPCMessage) => {
                                if (!writeSSEEvent(controller, encoder, message, eventId)) {
                                    throw new Error('Replay write failed: client disconnected');
                                }
                            }
                        });
                    } catch (error) {
                        failed = true;
                        onerror?.(error as Error);
                    }
                    if (failed || !isStandaloneReplay || cancelled) {
                        if (registeredController) session.clearStandaloneStream(sessionId, registeredController);
                        try {
                            controller.close();
                        } catch {
                            // Already closed.
                        }
                    }
                })();
            },
            cancel: () => {
                cancelled = true;
                if (registeredController) session.clearStandaloneStream(sessionId, registeredController);
            }
        });
        return new Response(readable, { headers });
    }

    async function handleDelete(req: Request): Promise<Response> {
        if (!session) {
            return jsonError(405, -32_000, 'Method Not Allowed: stateless handler does not support session DELETE', {
                headers: { Allow: 'POST' }
            });
        }
        const v = session.validateHeader(req);
        if (!v.ok) return v.response;
        const protoErr = validateProtocolVersion(req);
        if (protoErr) return protoErr;
        try {
            backchannel?.closeSession(v.sessionId!);
            await session.delete(v.sessionId!);
        } catch (error) {
            onerror?.(error as Error);
            return jsonError(500, -32_603, 'Internal server error');
        }
        return new Response(null, { status: 200 });
    }

    return async (req: Request, extra?: ShttpRequestExtra): Promise<Response> => {
        try {
            switch (req.method) {
                case 'POST': {
                    return await handlePost(req, extra);
                }
                case 'GET': {
                    return await handleGet(req);
                }
                case 'DELETE': {
                    return await handleDelete(req);
                }
                default: {
                    return jsonError(405, -32_000, 'Method not allowed.', { headers: { Allow: 'GET, POST, DELETE' } });
                }
            }
        } catch (error) {
            onerror?.(error as Error);
            return jsonError(500, -32_603, 'Internal server error');
        }
    };
}

export { type EventId, type EventStore, type StreamId } from './streamableHttp.js';
