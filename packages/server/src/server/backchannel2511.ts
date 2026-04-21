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
 * Isolated 2025-11 server-to-client request backchannel for {@linkcode shttpHandler}.
 *
 * The pre-2026-06 protocol allows a server to send `elicitation/create` and
 * `sampling/createMessage` requests to the client mid-tool-call by writing them as
 * SSE events on the open POST response stream and waiting for the client to POST
 * the response back. This class owns the per-session `{requestId -> resolver}`
 * map that correlation requires, plus the standalone-GET writer registry used for
 * unsolicited server notifications.
 *
 * It exists so this stateful behaviour is in one removable file once 2026-06 (MRTR)
 * is the floor and `env.send` becomes a hard error in stateless paths.
 */
export class Backchannel2511 {
    private _pending = new Map<string, Map<number, { resolve: (r: Result) => void; reject: (e: Error) => void }>>();
    private _standaloneWriters = new Map<string, (msg: JSONRPCMessage) => void>();
    private _nextId = 0;

    /**
     * Returns an `env.send` implementation bound to the given session and POST-stream writer.
     * The returned function writes the outbound JSON-RPC request to `writeSSE` and resolves when
     * {@linkcode handleResponse} is called for the same id on the same session.
     */
    makeEnvSend(sessionId: string, writeSSE: (msg: JSONRPCMessage) => void): (req: Request, opts?: RequestOptions) => Promise<Result> {
        return (req: Request, opts?: RequestOptions): Promise<Result> => {
            return new Promise<Result>((resolve, reject) => {
                if (opts?.signal?.aborted) {
                    reject(opts.signal.reason instanceof Error ? opts.signal.reason : new Error(String(opts.signal.reason)));
                    return;
                }

                const id = this._nextId++;
                const sessionMap = this._pending.get(sessionId) ?? new Map();
                this._pending.set(sessionId, sessionMap);

                const timeoutMs = opts?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC;
                const timer = setTimeout(() => {
                    sessionMap.delete(id);
                    reject(new SdkError(SdkErrorCode.RequestTimeout, 'Request timed out', { timeout: timeoutMs }));
                }, timeoutMs);

                const settle = {
                    resolve: (r: Result) => {
                        clearTimeout(timer);
                        sessionMap.delete(id);
                        resolve(r);
                    },
                    reject: (e: Error) => {
                        clearTimeout(timer);
                        sessionMap.delete(id);
                        reject(e);
                    }
                };
                sessionMap.set(id, settle);

                opts?.signal?.addEventListener(
                    'abort',
                    () => {
                        settle.reject(
                            opts.signal!.reason instanceof Error ? opts.signal!.reason : new Error(String(opts.signal!.reason))
                        );
                    },
                    { once: true }
                );

                const wire: JSONRPCRequest = { jsonrpc: '2.0', id, method: req.method, params: req.params };
                try {
                    writeSSE(wire);
                } catch (error) {
                    settle.reject(error instanceof Error ? error : new Error(String(error)));
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

    /**
     * Registers (or clears) the standalone GET subscription writer for a session, used to
     * deliver server-initiated notifications outside any POST request.
     */
    setStandaloneWriter(sessionId: string, write: ((msg: JSONRPCMessage) => void) | undefined): void {
        if (write) this._standaloneWriters.set(sessionId, write);
        else this._standaloneWriters.delete(sessionId);
    }

    /** Writes a message on the session's standalone GET stream, if one is open. */
    writeStandalone(sessionId: string, msg: JSONRPCMessage): boolean {
        const w = this._standaloneWriters.get(sessionId);
        if (!w) return false;
        try {
            w(msg);
            return true;
        } catch {
            this._standaloneWriters.delete(sessionId);
            return false;
        }
    }

    /** Rejects all pending requests for a session and forgets it. */
    closeSession(sessionId: string): void {
        const sessionMap = this._pending.get(sessionId);
        if (sessionMap) {
            const err = new SdkError(SdkErrorCode.ConnectionClosed, 'Session closed');
            for (const s of sessionMap.values()) s.reject(err);
            this._pending.delete(sessionId);
        }
        this._standaloneWriters.delete(sessionId);
    }
}
