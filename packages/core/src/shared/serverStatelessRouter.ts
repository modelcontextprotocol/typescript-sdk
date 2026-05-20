import { ZodError } from 'zod/v4';
import type { JSONRPCMessage, JSONRPCRequest, RequestId } from '../types/index.js';
import { isJSONRPCNotification, ProtocolError, ProtocolErrorCode } from '../types/index.js';
import { errorResponse } from './dispatcher.js';
import type { ListenContext, StatelessHandlers } from './stateless.js';
import { isStatelessRequest } from './stateless.js';

/**
 * Per-message router for pipe-shaped server transports (stdio, in-memory).
 * Call once per inbound message. Returns `true` if the message was claimed by
 * the stateless path (so the caller should NOT pass it to legacy `onmessage`).
 *
 * Stateless requests are dispatched via {@linkcode StatelessHandlers};
 * `notifications/cancelled` aborts a tracked in-flight request.
 */
export function routeServerStateless(
    message: JSONRPCMessage,
    handlers: StatelessHandlers,
    inflight: Map<RequestId, AbortController>,
    write: (m: JSONRPCMessage) => void,
    ctx: ListenContext,
    onerror?: (e: Error) => void
): boolean {
    if (isStatelessRequest(message)) {
        const ac = new AbortController();
        inflight.set(message.id, ac);
        void handleOne(handlers, message, ac, write, ctx)
            .catch(error => onerror?.(error instanceof Error ? error : new Error(String(error))))
            .finally(() => inflight.delete(message.id));
        return true;
    }
    if (isJSONRPCNotification(message) && message.method === 'notifications/cancelled') {
        const requestId = (message.params as { requestId?: RequestId } | undefined)?.requestId;
        const ac = requestId === undefined ? undefined : inflight.get(requestId);
        if (ac) {
            ac.abort();
            return true;
        }
    }
    return false;
}

async function handleOne(
    handlers: StatelessHandlers,
    req: JSONRPCRequest,
    ac: AbortController,
    write: (m: JSONRPCMessage) => void,
    ctx: ListenContext
): Promise<void> {
    if (req.method === 'subscriptions/listen') {
        let listenStream;
        try {
            listenStream = handlers.listen(req, ctx);
        } catch (error) {
            write(listenErrorResponse(req.id, error));
            return;
        }
        const { stream, close } = listenStream;
        ac.signal.addEventListener('abort', close, { once: true });
        try {
            for await (const m of stream) {
                if (ac.signal.aborted) break;
                write(m);
            }
            // Stream ended without a client-side abort (backend eviction or
            // natural end). Write a terminal error so StreamDriver's listen
            // queue closes instead of hanging indefinitely.
            if (!ac.signal.aborted) {
                write(errorResponse(req.id, ProtocolErrorCode.InternalError, 'Subscription stream ended'));
            }
        } catch (error) {
            if (!ac.signal.aborted) {
                write(listenErrorResponse(req.id, error));
            }
            throw error;
        } finally {
            ac.signal.removeEventListener('abort', close);
            close();
        }
    } else {
        const response = await handlers.dispatch(req, { signal: ac.signal, authInfo: ctx.authInfo, notify: write });
        write(response);
    }
}

function listenErrorResponse(id: RequestId, error: unknown) {
    if (error instanceof ProtocolError) {
        return errorResponse(id, error.code, error.message);
    }
    if (error instanceof ZodError) {
        return errorResponse(id, ProtocolErrorCode.InvalidParams, error.message);
    }
    return errorResponse(id, ProtocolErrorCode.InternalError, error instanceof Error ? error.message : 'Subscription failed');
}
