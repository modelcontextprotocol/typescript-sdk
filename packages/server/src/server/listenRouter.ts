/**
 * The entry-handled `subscriptions/listen` router for the HTTP serving entry.
 *
 * `createMcpHandler` recognizes a modern-classified `subscriptions/listen`
 * request and routes it here: the entry owns ack-first, per-stream filtering,
 * subscription-id stamping, keepalive, capacity guarding, and teardown. The
 * consumer's factory IS constructed for listen, to read the instance's
 * declared `ServerCapabilities` only — the probe instance is never connected
 * and is closed immediately after the capabilities read. Token verification
 * and any per-request authorization still belong at the middleware layer
 * mounted in front of `createMcpHandler` (the entry's documented authz
 * posture).
 *
 * Per the spec at protocol revision 2026-07-28:
 * - The acknowledged notification is the FIRST message on the stream and
 *   carries the honored subset of the requested filter.
 * - Every notification on the stream (including the ack) carries the listen
 *   request's JSON-RPC id under `_meta['io.modelcontextprotocol/subscriptionId']`.
 * - The server MUST NOT deliver a notification type the client did not request.
 * - Termination is stream close (HTTP); no JSON-RPC result is ever emitted.
 */
import type { JSONRPCRequest, RequestId, ServerCapabilities, SubscriptionFilter } from '@modelcontextprotocol/core';
import { SUBSCRIPTION_ID_META_KEY, SubscriptionFilterSchema } from '@modelcontextprotocol/core';

import type { ServerEventBus } from './serverEventBus.js';
import { honoredSubset, listenFilterAccepts, serverEventToNotification } from './serverEventBus.js';

/** Default SSE comment-frame keepalive interval for listen streams. */
export const DEFAULT_LISTEN_KEEPALIVE_MS = 15_000;

/** Default capacity guard: refuse a new subscription when this many are already open. */
export const DEFAULT_MAX_SUBSCRIPTIONS = 1024;

/** Options for {@linkcode createListenRouter}. */
export interface ListenRouterOptions {
    /** The event bus listen streams subscribe to. */
    bus: ServerEventBus;
    /** Reject a new listen with `-32603` when this many subscriptions are already open (default 1024). */
    maxSubscriptions?: number;
    /** SSE comment-frame keepalive interval; `0` disables keepalive (default 15000). */
    keepAliveMs?: number;
    /** Out-of-band error reporting (never alters the response). */
    onerror?: (error: Error) => void;
}

/**
 * A wire-shape notification body (method + loose params).
 * @internal
 */
export interface NotificationBody {
    method: string;
    params: { _meta?: Record<string, unknown>; [key: string]: unknown };
}

function jsonRpcError(id: RequestId | null, code: number, message: string): Response {
    return Response.json({ jsonrpc: '2.0', error: { code, message }, id }, { status: 200 });
}

/** Stamp the subscription id onto a notification's `_meta`. Non-mutating. */
function stampSubscriptionId(
    notification: { method: string; params?: { _meta?: Record<string, unknown>; [key: string]: unknown } },
    subscriptionId: RequestId
): NotificationBody {
    return {
        method: notification.method,
        params: {
            ...notification.params,
            _meta: { ...notification.params?._meta, [SUBSCRIPTION_ID_META_KEY]: subscriptionId }
        }
    };
}

/**
 * Read the requested filter off a `subscriptions/listen` request body.
 * Returns the validated filter, or `undefined` when `params.notifications`
 * is absent or fails the schema (the caller answers `-32602` — the spec
 * marks `notifications` REQUIRED on the listen request).
 */
export function parseListenFilter(message: JSONRPCRequest): SubscriptionFilter | undefined {
    const raw: unknown = message.params?.['notifications'];
    if (raw === undefined) return undefined;
    const parsed = SubscriptionFilterSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
}

/**
 * The HTTP listen router: holds the set of open subscriptions and serves
 * each listen request as an SSE response.
 */
export interface ListenRouter {
    /**
     * Serve one `subscriptions/listen` request and return the SSE `Response`
     * (or, on capacity / params rejection, the in-band JSON-RPC error
     * `Response`). The ack notification is the first SSE frame.
     *
     * `capabilities` is required: the acknowledged filter is always narrowed
     * against what the serving instance advertises (honoring a filter without
     * capabilities would fail open and deliver unadvertised types).
     */
    serve(message: JSONRPCRequest, signal: AbortSignal | undefined, capabilities: ServerCapabilities): Response;
    /**
     * Close every open subscription stream (HTTP teardown is stream close —
     * no JSON-RPC result is written).
     */
    closeAll(): void;
    /** The number of currently open subscription streams (for tests / introspection). */
    readonly openCount: number;
}

export function createListenRouter(options: ListenRouterOptions): ListenRouter {
    const { bus, onerror } = options;
    const maxSubscriptions = options.maxSubscriptions ?? DEFAULT_MAX_SUBSCRIPTIONS;
    const keepAliveMs = options.keepAliveMs ?? DEFAULT_LISTEN_KEEPALIVE_MS;

    const open = new Set<() => void>();

    function serve(message: JSONRPCRequest, signal: AbortSignal | undefined, capabilities: ServerCapabilities): Response {
        // Capacity guard, pre-ack: in-band -32603 on HTTP 200.
        if (open.size >= maxSubscriptions) {
            onerror?.(new Error(`subscriptions/listen refused: subscription limit reached (${maxSubscriptions})`));
            return jsonRpcError(message.id, -32_603, 'Subscription limit reached');
        }
        const filter = parseListenFilter(message);
        if (filter === undefined) {
            return jsonRpcError(message.id, -32_602, "Invalid params: 'notifications' is required and must be a valid SubscriptionFilter");
        }
        const honored = honoredSubset(filter, capabilities);
        // The spec carries the listen request's JSON-RPC id verbatim as the
        // subscription id; demux is per-connection (each HTTP listen has its
        // own SSE stream) so client-chosen ids cannot route across requests.
        const subscriptionId = message.id;

        const encoder = new TextEncoder();
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        let closed = false;
        let unsubscribe: (() => void) | undefined;
        let keepAliveTimer: ReturnType<typeof setInterval> | undefined;
        let abortCleanup: (() => void) | undefined;

        const writeFrame = (frame: string) => {
            if (closed) return;
            try {
                controller.enqueue(encoder.encode(frame));
            } catch (error) {
                onerror?.(error instanceof Error ? error : new Error(String(error)));
            }
        };
        const writeNotification = (method: string, params: { _meta?: Record<string, unknown>; [key: string]: unknown }) => {
            writeFrame(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method, params })}\n\n`);
        };

        const teardown = () => {
            if (closed) return;
            closed = true;
            unsubscribe?.();
            if (keepAliveTimer !== undefined) clearInterval(keepAliveTimer);
            abortCleanup?.();
            open.delete(teardown);
            try {
                controller.close();
            } catch {
                // Already closed/cancelled by the consumer.
            }
        };

        const readable = new ReadableStream<Uint8Array>({
            start(streamController) {
                controller = streamController;

                // Ack-first MUST: the acknowledged notification is the first
                // frame on the stream, stamped with the subscription id.
                const ack = stampSubscriptionId(
                    { method: 'notifications/subscriptions/acknowledged', params: { notifications: honored } },
                    subscriptionId
                );
                writeNotification(ack.method, ack.params);

                // Only after the ack frame is enqueued does delivery activate.
                unsubscribe = bus.subscribe(event => {
                    if (closed || !listenFilterAccepts(honored, event)) return;
                    const note = stampSubscriptionId(serverEventToNotification(event), subscriptionId);
                    writeNotification(note.method, note.params);
                });

                if (keepAliveMs > 0) {
                    keepAliveTimer = setInterval(() => writeFrame(': keepalive\n\n'), keepAliveMs);
                    // Do not hold the event loop open on idle subscriptions. Node's
                    // setInterval returns a Timeout with .unref(); browsers/Workers
                    // return a number — the cast is an environment shim, not a
                    // workaround for SDK typing.
                    (keepAliveTimer as { unref?: () => void }).unref?.();
                }

                open.add(teardown);
            },
            cancel() {
                // The client closed the SSE stream — the spec's HTTP cancel signal.
                teardown();
            }
        });

        if (signal !== undefined) {
            if (signal.aborted) {
                teardown();
            } else {
                const onAbort = () => teardown();
                signal.addEventListener('abort', onAbort, { once: true });
                abortCleanup = () => signal.removeEventListener('abort', onAbort);
            }
        }

        return new Response(readable, {
            status: 200,
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
                'X-Accel-Buffering': 'no'
            }
        });
    }

    return {
        serve,
        closeAll() {
            for (const teardown of open) teardown();
        },
        get openCount() {
            return open.size;
        }
    };
}

/* ------------------------------------------------------------------------ *
 * Stdio listen router
 * ------------------------------------------------------------------------ */

const CHANGE_NOTIFICATION_METHODS: ReadonlySet<string> = new Set([
    'notifications/tools/list_changed',
    'notifications/prompts/list_changed',
    'notifications/resources/list_changed',
    'notifications/resources/updated'
]);

/**
 * Per-connection listen state for the stdio entry. One instance is held by
 * `serveStdio` for the connection lifetime; it routes inbound
 * `subscriptions/listen` / `notifications/cancelled` and rewrites outbound
 * change notifications onto the active subscriptions. No bus — the long-lived
 * pinned instance's existing `send*ListChanged()` calls feed straight into
 * `routeOutbound()`.
 */
export class StdioListenRouter {
    /** Active subscriptions, keyed by the listen request's JSON-RPC id verbatim. */
    private readonly _subs = new Map<RequestId, SubscriptionFilter>();
    /**
     * The serving instance's declared capabilities. Filled in by the entry
     * once the modern instance is constructed (the router is created before
     * the instance exists), so the acknowledged filter is narrowed against
     * what the server can actually deliver.
     */
    private _serverCapabilities: ServerCapabilities | undefined;

    constructor(
        private readonly _maxSubscriptions: number = DEFAULT_MAX_SUBSCRIPTIONS,
        serverCapabilities?: ServerCapabilities
    ) {
        this._serverCapabilities = serverCapabilities;
    }

    /**
     * Record the serving instance's declared capabilities once it has been
     * constructed. Called by `serveStdio`'s connect path; subsequent
     * `serve()` calls narrow the honored filter against these.
     */
    setServerCapabilities(capabilities: ServerCapabilities): void {
        this._serverCapabilities = capabilities;
    }

    /** Whether `id` is an active listen subscription on this connection. */
    has(id: RequestId): boolean {
        return this._subs.has(id);
    }

    /**
     * Serve one inbound `subscriptions/listen` request: registers the
     * subscription and returns the stamped acknowledged notification (or, on
     * capacity / params rejection, the in-band JSON-RPC error response).
     *
     * @throws when called before {@linkcode setServerCapabilities} (or the
     * constructor) has supplied the serving instance's capabilities. Honoring a
     * filter without knowing the server's advertised capabilities would fail
     * open (deliver unadvertised types); the entry guarantees capabilities are
     * set before any listen request is routed here.
     */
    serve(message: JSONRPCRequest): NotificationBody | { jsonrpc: '2.0'; id: RequestId; error: { code: number; message: string } } {
        if (this._serverCapabilities === undefined) {
            throw new Error('StdioListenRouter.serve() called before setServerCapabilities(); refusing to honor a filter without capabilities');
        }
        if (this._subs.size >= this._maxSubscriptions) {
            return { jsonrpc: '2.0', id: message.id, error: { code: -32_603, message: 'Subscription limit reached' } };
        }
        const filter = parseListenFilter(message);
        if (filter === undefined) {
            return {
                jsonrpc: '2.0',
                id: message.id,
                error: { code: -32_602, message: "Invalid params: 'notifications' is required and must be a valid SubscriptionFilter" }
            };
        }
        const honored = honoredSubset(filter, this._serverCapabilities);
        this._subs.set(message.id, honored);
        return stampSubscriptionId({ method: 'notifications/subscriptions/acknowledged', params: { notifications: honored } }, message.id);
    }

    /**
     * Tear down one subscription (inbound `notifications/cancelled`). Returns
     * `true` when a subscription was removed. After this call NOTHING further
     * is delivered for that subscription id (the post-cancel hardening).
     */
    cancel(id: RequestId): boolean {
        return this._subs.delete(id);
    }

    /**
     * Route an outbound notification through the active subscriptions.
     *
     * - For a subscription-gated change notification, returns one stamped copy
     *   per subscription that opted in to it (an empty array means it is
     *   dropped — the modern era never delivers an un-requested change type).
     * - For any other outbound message, returns `'passthrough'` (the entry
     *   forwards it as-is).
     */
    routeOutbound(message: { method: string; params?: { [key: string]: unknown } }): NotificationBody[] | 'passthrough' {
        if (!CHANGE_NOTIFICATION_METHODS.has(message.method)) {
            return 'passthrough';
        }
        const uriParam: unknown = message.params?.['uri'];
        const uri = typeof uriParam === 'string' ? uriParam : undefined;
        const event = notificationToServerEvent(message.method, uri);
        const out: NotificationBody[] = [];
        for (const [subscriptionId, filter] of this._subs) {
            if (listenFilterAccepts(filter, event)) {
                out.push(stampSubscriptionId({ method: message.method, params: message.params ?? {} }, subscriptionId));
            }
        }
        return out;
    }

    /**
     * Server-side teardown of every active subscription: returns the single
     * `notifications/cancelled` per subscription id the entry MUST emit on
     * stdio teardown (and clears the set so nothing further is delivered).
     */
    teardownAll(): { jsonrpc: '2.0'; method: 'notifications/cancelled'; params: { requestId: RequestId } }[] {
        const out: { jsonrpc: '2.0'; method: 'notifications/cancelled'; params: { requestId: RequestId } }[] = [];
        for (const id of this._subs.keys()) {
            out.push({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } });
        }
        this._subs.clear();
        return out;
    }
}

function notificationToServerEvent(method: string, uri: string | undefined): import('./serverEventBus.js').ServerEvent {
    switch (method) {
        case 'notifications/tools/list_changed': {
            return { kind: 'tools_list_changed' };
        }
        case 'notifications/prompts/list_changed': {
            return { kind: 'prompts_list_changed' };
        }
        case 'notifications/resources/list_changed': {
            return { kind: 'resources_list_changed' };
        }
        default: {
            return { kind: 'resource_updated', uri: uri ?? '' };
        }
    }
}
