/**
 * The entry-handled `subscriptions/listen` router for the HTTP serving entry.
 *
 * `createMcpHandler` recognizes a modern-classified `subscriptions/listen`
 * request and routes it here BEFORE the consumer's factory is consulted: the
 * entry owns ack-first, per-stream filtering, subscription-id stamping,
 * keepalive, capacity guarding, and teardown. The factory is not constructed
 * for listen — token verification and any per-request authorization belong at
 * the middleware layer mounted in front of `createMcpHandler` (the entry's
 * documented authz posture); a factory that performs additional authorization
 * does not see listen requests.
 *
 * Per the spec at protocol revision 2026-07-28:
 * - The acknowledged notification is the FIRST message on the stream and
 *   carries the honored subset of the requested filter.
 * - Every notification on the stream (including the ack) carries the listen
 *   request's JSON-RPC id under `_meta['io.modelcontextprotocol/subscriptionId']`.
 * - The server MUST NOT deliver a notification type the client did not request.
 * - Termination is stream close (HTTP); no JSON-RPC result is ever emitted.
 */
import type { JSONRPCRequest, RequestId, SubscriptionFilter } from '@modelcontextprotocol/core';
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

/** A wire-shape notification body (method + loose params). */
interface NotificationBody {
    method: string;
    params: { _meta?: Record<string, unknown>; [key: string]: unknown };
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
 * fails the schema (the caller answers `-32602`).
 */
export function parseListenFilter(message: JSONRPCRequest): SubscriptionFilter | undefined {
    const raw = (message.params as { notifications?: unknown } | undefined)?.notifications;
    const parsed = SubscriptionFilterSchema.safeParse(raw ?? {});
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
     */
    serve(message: JSONRPCRequest, signal: AbortSignal | undefined): Response;
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

    function jsonRpcError(id: RequestId | null, code: number, message: string): Response {
        return Response.json({ jsonrpc: '2.0', error: { code, message }, id }, { status: 200 });
    }

    function serve(message: JSONRPCRequest, signal: AbortSignal | undefined): Response {
        // Capacity guard, pre-ack: in-band -32603 on HTTP 200.
        if (open.size >= maxSubscriptions) {
            onerror?.(new Error(`subscriptions/listen refused: subscription limit reached (${maxSubscriptions})`));
            return jsonRpcError(message.id, -32_603, 'Subscription limit reached');
        }
        const filter = parseListenFilter(message);
        if (filter === undefined) {
            return jsonRpcError(message.id, -32_602, "Invalid params: 'notifications' is not a valid SubscriptionFilter");
        }
        const honored = honoredSubset(filter);
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
                    // Do not hold the event loop open on idle subscriptions.
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
            for (const teardown of [...open]) teardown();
        },
        get openCount() {
            return open.size;
        }
    };
}
