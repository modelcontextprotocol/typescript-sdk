import type {
    JSONRPCErrorResponse,
    JSONRPCMessage,
    JSONRPCRequest,
    JSONRPCResultResponse,
    Request,
    RequestOptions,
    Result
} from '@modelcontextprotocol/core';
import { DEFAULT_REQUEST_TIMEOUT_MSEC, isJSONRPCErrorResponse, ProtocolError, SdkError, SdkErrorCode } from '@modelcontextprotocol/core';

/**
 * Isolated 2025-11 server-to-client request backchannel for `handleHttp`.
 *
 * The 2025-11 protocol allows a server to send `elicitation/create` and
 * `sampling/createMessage` requests to the client mid-tool-call by writing them as
 * SSE events on the open POST response stream and waiting for the client to POST
 * the response back. This class owns the per-session `{requestId -> resolver}`
 * map that correlation requires.
 *
 * It exists so this stateful behaviour is in one removable file once MRTR
 * (SEP-2322) is the protocol floor and `env.send` becomes a hard error in
 * stateless paths.
 */
export class BackchannelCompat {
    private _pending = new Map<string, Map<number, { resolve: (r: Result) => void; reject: (e: Error) => void }>>();
    private _nextId = 0;

    /**
     * Returns an `env.send` implementation bound to the given session and POST-stream writer.
     * The returned function writes the outbound JSON-RPC request to `writeSSE` and resolves when
     * {@linkcode handleResponse} is called for the same id on the same session.
     *
     * `writeSSE` returns `false` when the underlying stream is closed; the returned promise then
     * rejects immediately with `SendFailed` instead of waiting for the timeout.
     */
    makeEnvSend(sessionId: string, writeSSE: (msg: JSONRPCMessage) => boolean): (req: Request, opts?: RequestOptions) => Promise<Result> {
        return (req: Request, opts?: RequestOptions): Promise<Result> => {
            return new Promise<Result>((resolve, reject) => {
                if (opts?.signal?.aborted) {
                    reject(opts.signal.reason instanceof Error ? opts.signal.reason : new Error(String(opts.signal.reason)));
                    return;
                }

                const id = this._nextId++;
                const sessionMap = this._pending.get(sessionId) ?? new Map();
                this._pending.set(sessionId, sessionMap);

                // eslint-disable-next-line prefer-const -- forward-referenced by cleanup() before assignment site
                let timer: ReturnType<typeof setTimeout> | undefined;
                const onAbort = () => {
                    // Tell the client to stop processing, then reject locally.
                    writeSSE({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } });
                    settle.reject(opts!.signal!.reason instanceof Error ? opts!.signal!.reason : new Error(String(opts!.signal!.reason)));
                };
                const cleanup = () => {
                    if (timer !== undefined) clearTimeout(timer);
                    sessionMap.delete(id);
                    if (sessionMap.size === 0) this._pending.delete(sessionId);
                    opts?.signal?.removeEventListener('abort', onAbort);
                };
                const settle = {
                    resolve: (r: Result) => {
                        cleanup();
                        resolve(r);
                    },
                    reject: (e: Error) => {
                        cleanup();
                        reject(e);
                    }
                };
                sessionMap.set(id, settle);

                const timeoutMs = opts?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC;
                timer = setTimeout(
                    () => settle.reject(new SdkError(SdkErrorCode.RequestTimeout, 'Request timed out', { timeout: timeoutMs })),
                    timeoutMs
                );

                opts?.signal?.addEventListener('abort', onAbort, { once: true });

                const wire: JSONRPCRequest = { jsonrpc: '2.0', id, method: req.method, params: req.params };
                if (!writeSSE(wire)) {
                    settle.reject(new SdkError(SdkErrorCode.SendFailed, 'Backchannel stream closed'));
                }
            });
        };
    }

    /**
     * Routes an incoming JSON-RPC response (from a client POST) to the waiting `env.send` promise.
     * @returns true if a pending request matched and was settled.
     */
    handleResponse(sessionId: string, response: JSONRPCResultResponse | JSONRPCErrorResponse): boolean {
        const sessionMap = this._pending.get(sessionId);
        const id = typeof response.id === 'number' ? response.id : Number(response.id);
        const settle = sessionMap?.get(id);
        if (!settle) return false;
        if (isJSONRPCErrorResponse(response)) {
            settle.reject(ProtocolError.fromError(response.error.code, response.error.message, response.error.data));
        } else {
            settle.resolve(response.result);
        }
        return true;
    }

    /** Rejects all pending requests for a session and forgets it. */
    closeSession(sessionId: string): void {
        const sessionMap = this._pending.get(sessionId);
        if (!sessionMap) return;
        const err = new SdkError(SdkErrorCode.ConnectionClosed, 'Session closed');
        for (const s of sessionMap.values()) s.reject(err);
        this._pending.delete(sessionId);
    }
}
