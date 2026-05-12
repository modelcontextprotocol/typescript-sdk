import type {
    IncompleteResult,
    InputRequest,
    JSONRPCErrorResponse,
    JSONRPCMessage,
    JSONRPCRequest,
    JSONRPCResultResponse,
    Request,
    RequestEnv,
    RequestOptions,
    Result
} from '@modelcontextprotocol/core';
import { isJSONRPCErrorResponse, isJSONRPCResultResponse, ProtocolErrorCode, SdkError, SdkErrorCode } from '@modelcontextprotocol/core';

import type { ShttpCallbacks } from './shttpHandler.js';

/** Map of input-request slot key → outbound request. */
type InputRequests = Record<string, InputRequest>;
/**
 * Map of slot key → answer. Flat `Result` per {@linkcode InputResponseRequestParams}; the
 * client services each {@linkcode InputRequest} and sends back the bare result. A missing
 * key rejects the parked `env.send` with {@linkcode SdkErrorCode.SendFailed}.
 */
type InputResponses = Record<string, Result>;

/** Options for {@linkcode ContinuationCompat}. */
export interface ContinuationCompatOptions {
    /**
     * Maximum number of suspended handler frames to retain. New suspensions beyond this
     * cap yield a JSON-RPC `-32000` error response for the request. Defaults to 1000.
     */
    maxContinuations?: number;
    /**
     * How long a suspended frame waits for the client to retry before being aborted.
     * Reset on each retry. Defaults to 5 minutes.
     */
    ttlMs?: number;
    /**
     * Generates the opaque `requestState` token. SHOULD be unguessable.
     * @default `() => crypto.randomUUID()`
     */
    requestStateGenerator?: () => string;
    /** Called when a frame is evicted on TTL. */
    onexpired?: (requestState: string) => void;
    /**
     * If `false` (default), {@linkcode ContinuationCompat.wrap} rejects when no principal can
     * be derived (no `authInfo.token` and no `mcp-session-id`). Anonymous suspension means any
     * caller can resume any frame; only enable this for trusted single-tenant deployments.
     */
    allowAnonymousSuspend?: boolean;
    /**
     * Maximum suspended frames a single principal may hold. New suspensions beyond this throw.
     * Prevents one tenant exhausting `maxContinuations`. Defaults to `Math.ceil(maxContinuations / 10)`.
     */
    perPrincipalMax?: number;
}

type Ask =
    | { kind: 'message'; msg: JSONRPCMessage }
    | { kind: 'incomplete'; inputRequests: InputRequests }
    | { kind: 'done' }
    | { kind: 'runnerError'; error: unknown };

interface Channel<T> {
    next: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: unknown) => void;
}
function channel<T>(): Channel<T> {
    let resolve!: (v: T) => void;
    let reject!: (r?: unknown) => void;
    const next = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { next, resolve, reject };
}

/**
 * One suspended handler frame: a detached `onrequest` iterator plus the two
 * channels that thread {@linkcode InputRequests} out and {@linkcode InputResponses} back in.
 */
class Continuation {
    private askCh: Channel<Ask> = channel();
    private answerCh: Channel<InputResponses> = channel();
    private askQueue: Ask[] = [];
    readonly abort = new AbortController();

    push(a: Ask): void {
        this.askQueue.push(a);
        const ch = this.askCh;
        this.askCh = channel();
        ch.resolve(a);
    }

    async nextAsk(): Promise<Ask> {
        if (this.askQueue.length > 0) {
            const a = this.askQueue.shift()!;
            return a;
        }
        const a = await this.askCh.next;
        // The producer pushed into the queue at the same time as resolving; drop that copy.
        const idx = this.askQueue.indexOf(a);
        if (idx !== -1) this.askQueue.splice(idx, 1);
        return a;
    }

    answer(responses: InputResponses): void {
        const ch = this.answerCh;
        this.answerCh = channel();
        ch.resolve(responses);
    }

    nextAnswer(): Promise<InputResponses> {
        return this.answerCh.next;
    }

    fail(reason: Error): void {
        this.abort.abort(reason);
        // Defang the channel before rejecting: nextAnswer() may not have been awaited yet
        // (handler is in non-send async work, or answer() just rotated in a fresh channel).
        // Without this the reject lands as an unhandled rejection.
        this.answerCh.next.catch(() => {});
        this.answerCh.reject(reason);
    }
}

/**
 * Opt-in suspend/resume continuation store for {@linkcode @modelcontextprotocol/server!index.handleHttp | handleHttp}, the SEP-2322
 * "Option H" stateful server path.
 *
 * When configured, a handler's `await ctx.mcpReq.send(...)` (and the higher-level
 * `elicitInput`/`requestSampling`) becomes a real suspension point: the call parks the
 * handler's frame in this store, the current HTTP response carries an
 * `IncompleteResult` with `inputRequests` and a `requestState` token, and a later POST
 * with `params.{requestState, inputResponses}` resumes the same frame from where it
 * stopped. The handler runs once, front-to-back; nothing above the `await` re-executes.
 *
 * Single-process only. The frame lives in this instance's memory; horizontal scale
 * needs sticky routing on the `requestState` token. Mutually exclusive with
 * {@linkcode BackchannelCompat} (both supply `env.send`; this one wins when both are set).
 *
 * Tenant isolation: each frame is bound to the validated principal that created it
 * (`env.authInfo.token`, falling back to `env.sessionId`). Resume from a different
 * principal is rejected. By default, requests with no derivable principal are refused
 * (see {@linkcode ContinuationCompatOptions.allowAnonymousSuspend}); deploy behind an
 * authenticating middleware or `SessionCompat`. A per-principal frame cap
 * ({@linkcode ContinuationCompatOptions.perPrincipalMax}) prevents any one tenant from
 * exhausting the global `maxContinuations`.
 */
/**
 * Validated identity to bind a frame to. Prefers the auth token (server-validated) over
 * the legacy `mcp-session-id`. Never derived from `_meta` (client-asserted).
 */
function principalOf(env: RequestEnv): string | undefined {
    return env.authInfo?.token ?? env.sessionId ?? (env.ext?.sessionId as string | undefined);
}

interface FrameEntry {
    cont: Continuation;
    timer: ReturnType<typeof setTimeout>;
    /** Validated identity that created the frame; resume requires the same. */
    owner: string | undefined;
    /**
     * Set while a `_drive` loop is currently consuming this continuation. A second
     * concurrent resume for the same `requestState` is rejected to prevent both drives
     * draining the same ask channel (which would duplicate messages and drop the second
     * resume's `inputResponses`).
     */
    draining: boolean;
}

export class ContinuationCompat {
    private readonly _frames = new Map<string, FrameEntry>();
    private readonly _perPrincipalCount = new Map<string, number>();
    private readonly _max: number;
    private readonly _perPrincipalMax: number;
    private readonly _ttlMs: number;
    private readonly _generate: () => string;
    private readonly _onexpired?: (requestState: string) => void;
    private readonly _allowAnonymous: boolean;

    constructor(options: ContinuationCompatOptions = {}) {
        this._max = options.maxContinuations ?? 1000;
        this._perPrincipalMax = options.perPrincipalMax ?? Math.ceil(this._max / 10);
        this._ttlMs = options.ttlMs ?? 5 * 60_000;
        this._generate = options.requestStateGenerator ?? (() => crypto.randomUUID());
        this._onexpired = options.onexpired;
        this._allowAnonymous = options.allowAnonymousSuspend ?? false;
    }

    /**
     * Returns a JSON-RPC error response for the given message; the three new-frame
     * guards yield this instead of throwing so SSE-mode clients receive the error
     * (a throw inside `_drive` is swallowed by `shttpHandler`'s outer catch and the
     * stream just closes empty).
     */
    private _capacityError(id: JSONRPCRequest['id'], message: string): JSONRPCErrorResponse {
        return { jsonrpc: '2.0', id, error: { code: -32_000, message } };
    }

    private _decPrincipal(owner: string | undefined): void {
        if (owner === undefined) return;
        const n = (this._perPrincipalCount.get(owner) ?? 1) - 1;
        if (n <= 0) this._perPrincipalCount.delete(owner);
        else this._perPrincipalCount.set(owner, n);
    }

    /** Number of currently suspended frames. */
    get size(): number {
        return this._frames.size;
    }

    /** True if `requestState` matches a live suspended frame. */
    has(requestState: string): boolean {
        return this._frames.has(requestState);
    }

    /**
     * Aborts and forgets a frame. Any parked `env.send` rejects with
     * {@linkcode SdkErrorCode.ConnectionClosed}.
     */
    abort(requestState: string, reason?: Error): void {
        const entry = this._frames.get(requestState);
        if (!entry) return;
        clearTimeout(entry.timer);
        this._frames.delete(requestState);
        this._decPrincipal(entry.owner);
        const err = reason ?? new SdkError(SdkErrorCode.ConnectionClosed, 'Continuation aborted');
        entry.cont.fail(err);
        // Signal an active drain loop (awaiting nextAsk) so it does not hang.
        entry.cont.push({ kind: 'runnerError', error: err });
    }

    /** Aborts all frames. Call from server shutdown. */
    close(): void {
        for (const token of this._frames.keys()) this.abort(token);
    }

    /**
     * Wraps `onrequest` so it suspends on `env.send` instead of needing a live
     * peer channel. Called by {@linkcode @modelcontextprotocol/server!index.handleHttp | handleHttp} when this instance is configured
     * via `ShttpHandlerOptions.continuations`.
     */
    wrap(onrequest: NonNullable<ShttpCallbacks['onrequest']>): NonNullable<ShttpCallbacks['onrequest']> {
        return (request, env) => this._drive(onrequest, request, env ?? {});
    }

    private async *_drive(
        onrequest: NonNullable<ShttpCallbacks['onrequest']>,
        request: JSONRPCRequest,
        env: RequestEnv
    ): AsyncGenerator<JSONRPCMessage, void, void> {
        const params = (request.params ?? {}) as { requestState?: unknown; inputResponses?: unknown };
        const incomingState = typeof params.requestState === 'string' ? params.requestState : undefined;

        let token: string;
        let cont: Continuation;

        if (incomingState !== undefined && this._frames.has(incomingState)) {
            token = incomingState;
            const entry = this._frames.get(token)!;
            if (entry.owner !== principalOf(env)) {
                yield {
                    jsonrpc: '2.0',
                    id: request.id,
                    error: { code: -32_600, message: 'Invalid requestState: does not belong to this caller' }
                } satisfies JSONRPCErrorResponse;
                return;
            }
            if (entry.draining) {
                yield {
                    jsonrpc: '2.0',
                    id: request.id,
                    error: { code: -32_600, message: 'Invalid requestState: resume already in progress' }
                } satisfies JSONRPCErrorResponse;
                return;
            }
            entry.draining = true;
            cont = entry.cont;
            clearTimeout(entry.timer);
            entry.timer = this._arm(token);
            const responses = (params.inputResponses ?? {}) as InputResponses;
            cont.answer(responses);
        } else if (incomingState === undefined) {
            const owner = principalOf(env);
            if (owner === undefined && !this._allowAnonymous) {
                yield this._capacityError(
                    request.id,
                    'ContinuationCompat: refusing to suspend without a principal (no authInfo.token or mcp-session-id). ' +
                        'Deploy behind authenticating middleware, configure SessionCompat, or set allowAnonymousSuspend: true.'
                );
                return;
            }
            if (this._frames.size >= this._max) {
                yield this._capacityError(request.id, `ContinuationCompat at capacity (maxContinuations=${this._max})`);
                return;
            }
            if (owner !== undefined) {
                const n = this._perPrincipalCount.get(owner) ?? 0;
                if (n >= this._perPrincipalMax) {
                    yield this._capacityError(
                        request.id,
                        `ContinuationCompat: principal at per-principal capacity (perPrincipalMax=${this._perPrincipalMax})`
                    );
                    return;
                }
                this._perPrincipalCount.set(owner, n + 1);
            }
            token = this._generate();
            cont = new Continuation();
            this._frames.set(token, { cont, timer: this._arm(token), owner, draining: true });
            this._startRunner(onrequest, request, env, cont, token);
        } else {
            yield {
                jsonrpc: '2.0',
                id: request.id,
                error: { code: -32_600, message: 'Invalid requestState: continuation expired or unknown' }
            } satisfies JSONRPCErrorResponse;
            return;
        }

        // Drain the ask channel into the current HTTP response stream until the
        // handler either finishes or parks for input. The finally clears `draining`
        // so a client disconnect mid-stream (caller stops iterating this generator)
        // does not leave the frame permanently locked against retry.
        try {
            for (;;) {
                const a = await cont.nextAsk();
                if (a.kind === 'message') {
                    yield this._rewriteId(a.msg, request.id);
                    continue;
                }
                if (a.kind === 'incomplete') {
                    const result: IncompleteResult = {
                        resultType: 'incomplete',
                        inputRequests: a.inputRequests,
                        requestState: token
                    };
                    yield { jsonrpc: '2.0', id: request.id, result } satisfies JSONRPCResultResponse;
                    return;
                }
                if (a.kind === 'runnerError') {
                    this._delete(token);
                    yield {
                        jsonrpc: '2.0',
                        id: request.id,
                        error: {
                            code: ProtocolErrorCode.InternalError,
                            message: a.error instanceof Error ? a.error.message : String(a.error)
                        }
                    } satisfies JSONRPCErrorResponse;
                    return;
                }
                // done
                this._delete(token);
                return;
            }
        } finally {
            const entry = this._frames.get(token);
            if (entry) entry.draining = false;
        }
    }

    private _startRunner(
        onrequest: NonNullable<ShttpCallbacks['onrequest']>,
        request: JSONRPCRequest,
        env: RequestEnv,
        cont: Continuation,
        token: string
    ): void {
        const signal =
            env.signal === undefined
                ? cont.abort.signal
                : (anySignal([env.signal, cont.abort.signal]) ?? linkSignals(env.signal, cont.abort.signal));
        const runnerEnv: RequestEnv = { ...env, signal, send: this._suspendingSend(cont) };

        void (async () => {
            try {
                for await (const msg of onrequest(request, runnerEnv)) {
                    cont.push({ kind: 'message', msg });
                }
                cont.push({ kind: 'done' });
            } catch (error) {
                if (this._frames.has(token)) {
                    cont.push({ kind: 'runnerError', error });
                }
            }
        })();
    }

    /**
     * Builds the `env.send` backing function that parks the handler instead of needing a
     * live peer channel. Calls in the same microtask are batched into one
     * {@linkcode IncompleteResult}; the next microtask flushes the batch as a single
     * `incomplete` ask.
     *
     * Positional keys (`r0`, `r1`, ...) are **per round**: each new batch resets to `r0`,
     * matching the dispatcher's `ephemeralSend` so a given `inputResponses` map is shaped
     * identically on either path.
     */
    private _suspendingSend(cont: Continuation): NonNullable<RequestEnv['send']> {
        let counter = 0;
        let batch: { inputs: InputRequests; settle: Promise<InputResponses>; flushed: boolean } | undefined;

        return (req: Request, opts?: RequestOptions): Promise<Result> => {
            if (opts?.signal?.aborted) {
                const r = opts.signal.reason;
                return Promise.reject(r instanceof Error ? r : new Error(String(r)));
            }

            if (batch === undefined || batch.flushed) {
                counter = 0;
                const b: { inputs: InputRequests; settle: Promise<InputResponses>; flushed: boolean } = {
                    inputs: {},
                    settle: cont.nextAnswer(),
                    flushed: false
                };
                batch = b;
                queueMicrotask(() => {
                    b.flushed = true;
                    cont.push({ kind: 'incomplete', inputRequests: b.inputs });
                });
            }
            const key = `r${counter++}`;
            batch.inputs[key] = { method: req.method, ...(req.params === undefined ? {} : { params: req.params }) };
            const settle = batch.settle;

            return new Promise<Result>((resolve, reject) => {
                const onAbort = () => {
                    const r = opts!.signal!.reason;
                    reject(r instanceof Error ? r : new Error(String(r)));
                };
                opts?.signal?.addEventListener('abort', onAbort, { once: true });
                settle.then(
                    responses => {
                        opts?.signal?.removeEventListener('abort', onAbort);
                        if (!(key in responses)) {
                            reject(new SdkError(SdkErrorCode.SendFailed, `inputResponses missing entry for slot "${key}"`));
                            return;
                        }
                        resolve(responses[key]!);
                    },
                    error => {
                        opts?.signal?.removeEventListener('abort', onAbort);
                        reject(error instanceof Error ? error : new Error(String(error)));
                    }
                );
            });
        };
    }

    private _rewriteId(msg: JSONRPCMessage, id: JSONRPCRequest['id']): JSONRPCMessage {
        if (isJSONRPCResultResponse(msg) || isJSONRPCErrorResponse(msg)) {
            return { ...msg, id };
        }
        return msg;
    }

    private _arm(token: string): ReturnType<typeof setTimeout> {
        return setTimeout(() => {
            const entry = this._frames.get(token);
            if (!entry) return;
            this._frames.delete(token);
            this._decPrincipal(entry.owner);
            const reason = new SdkError(SdkErrorCode.RequestTimeout, `Continuation ${token} expired after ${this._ttlMs}ms`);
            // Signal an active drain loop (awaiting nextAsk) so it does not hang.
            entry.cont.push({ kind: 'runnerError', error: reason });
            // Reject the runner's parked answer-await so the handler unwinds.
            entry.cont.fail(reason);
            this._onexpired?.(token);
        }, this._ttlMs);
    }

    private _delete(token: string): void {
        const entry = this._frames.get(token);
        if (!entry) return;
        clearTimeout(entry.timer);
        this._frames.delete(token);
        this._decPrincipal(entry.owner);
    }
}

type SignalAny = (signals: AbortSignal[]) => AbortSignal;
function anySignal(signals: AbortSignal[]): AbortSignal | undefined {
    const fn = (AbortSignal as { any?: SignalAny }).any;
    return fn ? fn(signals) : undefined;
}
function linkSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
    const c = new AbortController();
    const fwd = (s: AbortSignal) => {
        if (s.aborted) c.abort(s.reason);
        else s.addEventListener('abort', () => c.abort(s.reason), { once: true });
    };
    fwd(a);
    fwd(b);
    return c.signal;
}
