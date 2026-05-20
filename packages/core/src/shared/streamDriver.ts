import { isJSONRPCNotification, isJSONRPCResponse } from '../types/guards.js';
import type { JSONRPCMessage, JSONRPCRequest, RequestId } from '../types/index.js';
import { JSONRPC_VERSION, ProtocolErrorCode } from '../types/index.js';
import { AsyncQueue } from '../util/asyncQueue.js';
import { META_KEYS } from './stateless.js';

/**
 * Minimal request→response correlator for pipe-shaped client transports
 * (stdio, in-memory) under the 2026-06 stateless model. Provides
 * `sendAndReceive(request) → AsyncIterable<JSONRPCMessage>` so the Client can
 * make stateless calls without going through `Protocol.request()` and its
 * `_responseHandlers` map.
 *
 * The transport feeds every inbound message to {@linkcode onMessage}; the
 * driver routes responses by `id` and notifications by `_meta.subscriptionId`
 * (which is the originating request's id, per SEP-2575) to the matching
 * iterator. Closing/breaking the iterator sends `notifications/cancelled`.
 */
export class StreamDriver {
    // Seed in a range Protocol's `_requestMessageId` (which starts at 0) will
    // not reach, so a stdio fallback that mixes a discover-probe (StreamDriver)
    // with a legacy initialize (Protocol.request) on the same pipe cannot
    // collide on id 0.
    private _nextId = 0x40_00_00_00;
    private readonly _pending = new Map<RequestId, AsyncQueue<JSONRPCMessage>>();

    constructor(private readonly _send: (m: JSONRPCMessage) => Promise<void>) {}

    /**
     * Sends one request and returns an async-iterable of the messages the server
     * emits for it: zero or more notifications, then exactly one response (which
     * ends the iteration). For `subscriptions/listen`, the iteration continues
     * until `break`/`return()` (which sends `notifications/cancelled`).
     *
     * The request is dispatched and registered in `_pending` immediately, before
     * the first `next()`. Callers MUST consume the iterable (`for await` is
     * sufficient: it calls `return()` on break/throw); obtaining it and never
     * iterating leaks the `_pending` entry until {@linkcode close}.
     */
    sendAndReceive(request: Omit<JSONRPCRequest, 'jsonrpc' | 'id'>, opts?: { signal?: AbortSignal }): AsyncIterable<JSONRPCMessage> {
        const id = this._nextId++;
        const isListen = request.method === 'subscriptions/listen';
        const queue = new AsyncQueue<JSONRPCMessage>(256);

        const cleanup = () => {
            this._pending.delete(id);
            this._pending.delete(String(id));
            opts?.signal?.removeEventListener('abort', onAbort);
        };
        const cancel = () => {
            if (queue.closed) return;
            this._send({ jsonrpc: JSONRPC_VERSION, method: 'notifications/cancelled', params: { requestId: id } }).catch(() => {});
            queue.close();
            cleanup();
        };
        const onAbort = () => cancel();
        opts?.signal?.addEventListener('abort', onAbort, { once: true });

        this._pending.set(id, queue);
        // `_meta.subscriptionId` on inbound notifications equals the string form
        // of the request id (SEP-2575). Register the same queue under that key
        // so {@linkcode onMessage} can route notifications without a second map.
        this._pending.set(String(id), queue);

        this._send({ jsonrpc: JSONRPC_VERSION, id, ...request }).catch(error => {
            // Surface send failure to the iterator instead of hanging forever.
            queue.push({
                jsonrpc: JSONRPC_VERSION,
                id,
                error: {
                    code: ProtocolErrorCode.InternalError,
                    message: `Transport send failed: ${error instanceof Error ? error.message : String(error)}`
                }
            });
            queue.close();
            cleanup();
        });

        const inner = queue.iterate();
        return {
            [Symbol.asyncIterator]: () => ({
                async next(): Promise<IteratorResult<JSONRPCMessage>> {
                    const r = await inner.next();
                    if (r.done) {
                        cleanup();
                    } else if (!isListen && isJSONRPCResponse(r.value)) {
                        // Non-listen: end after the response.
                        queue.close();
                        cleanup();
                    }
                    return r;
                },
                async return(): Promise<IteratorResult<JSONRPCMessage>> {
                    cancel();
                    return { value: undefined, done: true };
                }
            })
        };
    }

    /**
     * Feeds one inbound message to the driver. The transport calls this for
     * every message received while in stateless mode. Returns `true` if the
     * message was claimed (routed to a pending iterator).
     */
    onMessage(m: JSONRPCMessage): boolean {
        if ('id' in m && m.id !== null && m.id !== undefined) {
            const q = this._pending.get(m.id);
            if (q) {
                q.push(m);
                return true;
            }
        }
        if (isJSONRPCNotification(m)) {
            const sid = (m.params?._meta as Record<string, unknown> | undefined)?.[META_KEYS.subscriptionId];
            if (typeof sid === 'string') {
                const q = this._pending.get(sid);
                if (q) {
                    q.push(m);
                    return true;
                }
            }
        }
        return false;
    }

    /** Ends every pending iterator (e.g., on transport close). */
    close(): void {
        for (const q of this._pending.values()) q.close();
        this._pending.clear();
    }
}
