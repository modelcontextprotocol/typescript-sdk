import { SdkError, SdkErrorCode } from '../errors/sdkErrors.js';
import type {
    AuthInfo,
    JSONRPCErrorResponse,
    JSONRPCNotification,
    JSONRPCRequest,
    JSONRPCResponse,
    Notification,
    NotificationMethod,
    NotificationTypeMap,
    Request,
    RequestId,
    RequestMethod,
    RequestTypeMap,
    Result,
    ResultTypeMap
} from '../types/index.js';
import { getNotificationSchema, getRequestSchema, ProtocolErrorCode } from '../types/index.js';
import type { BaseContext, RequestOptions } from './protocol.js';
import type { TaskContext } from './taskManager.js';

/**
 * Per-dispatch environment provided by the caller (driver). Everything is optional;
 * a bare {@linkcode Dispatcher.dispatch} call works with no transport at all.
 */
export type DispatchEnv = {
    /**
     * Sends a request back to the peer (server→client elicitation/sampling, or
     * client→server nested calls). Supplied by {@linkcode StreamDriver} when running
     * over a persistent pipe. Defaults to throwing {@linkcode SdkErrorCode.NotConnected}.
     */
    send?: (request: Request, options?: RequestOptions) => Promise<Result>;

    /** Session identifier from the transport, if any. Surfaced as {@linkcode BaseContext.sessionId}. */
    sessionId?: string;

    /** Validated auth token info for HTTP transports. */
    authInfo?: AuthInfo;

    /** Original HTTP {@linkcode globalThis.Request | Request}, if any. */
    httpReq?: globalThis.Request;

    /** Abort signal for the inbound request. If omitted, a fresh controller is created. */
    signal?: AbortSignal;

    /** Task context, if task storage is configured by the caller. */
    task?: TaskContext;
};

/**
 * One yielded item from {@linkcode Dispatcher.dispatch}. A dispatch yields zero or more
 * notifications followed by exactly one terminal response.
 */
export type DispatchOutput =
    | { kind: 'notification'; message: JSONRPCNotification }
    | { kind: 'response'; message: JSONRPCResponse | JSONRPCErrorResponse };

/**
 * Envelope-agnostic output from {@linkcode Dispatcher.dispatchRaw}. No JSON-RPC `{jsonrpc, id}` wrapping.
 */
export type RawDispatchOutput =
    | { kind: 'notification'; method: string; params?: Record<string, unknown> }
    | { kind: 'result'; result: Result }
    | { kind: 'error'; code: number; message: string; data?: unknown };

type RawHandler<ContextT> = (request: JSONRPCRequest, ctx: ContextT) => Promise<Result>;

/**
 * Stateless JSON-RPC handler registry with a request-in / messages-out
 * {@linkcode Dispatcher.dispatch | dispatch()} entry point.
 *
 * Holds no transport, no correlation state, no timers. One instance can serve
 * any number of concurrent requests from any driver.
 */
export class Dispatcher<ContextT extends BaseContext = BaseContext> {
    protected _requestHandlers: Map<string, RawHandler<ContextT>> = new Map();
    protected _notificationHandlers: Map<string, (n: JSONRPCNotification) => Promise<void>> = new Map();

    /**
     * A handler to invoke for any request types that do not have their own handler installed.
     */
    fallbackRequestHandler?: (request: JSONRPCRequest, ctx: ContextT) => Promise<Result>;

    /**
     * A handler to invoke for any notification types that do not have their own handler installed.
     */
    fallbackNotificationHandler?: (notification: Notification) => Promise<void>;

    /**
     * Subclasses override to enrich the context (e.g. {@linkcode ServerContext}). Default returns base unchanged.
     */
    protected buildContext(base: BaseContext, _env: DispatchEnv): ContextT {
        return base as ContextT;
    }

    /**
     * Dispatch one inbound request. Yields any notifications the handler emits via
     * `ctx.mcpReq.notify()`, then yields exactly one terminal response.
     *
     * Never throws for handler errors; they are wrapped as JSON-RPC error responses.
     * May throw if iteration itself is misused.
     */
    async *dispatch(request: JSONRPCRequest, env: DispatchEnv = {}): AsyncGenerator<DispatchOutput, void, void> {
        const handler = this._requestHandlers.get(request.method) ?? this.fallbackRequestHandler;

        if (handler === undefined) {
            yield errorResponse(request.id, ProtocolErrorCode.MethodNotFound, 'Method not found');
            return;
        }

        const queue: JSONRPCNotification[] = [];
        let wake: (() => void) | undefined;
        let done = false;
        let final: JSONRPCResponse | JSONRPCErrorResponse | undefined;

        const localAbort = new AbortController();
        if (env.signal) {
            if (env.signal.aborted) localAbort.abort(env.signal.reason);
            else env.signal.addEventListener('abort', () => localAbort.abort(env.signal!.reason), { once: true });
        }

        const send =
            env.send ??
            (async () => {
                throw new SdkError(
                    SdkErrorCode.NotConnected,
                    'ctx.mcpReq.send is unavailable: no peer channel. Use the MRTR-native return form for elicitation/sampling, or run via connect()/StreamDriver.'
                );
            });

        const base: BaseContext = {
            sessionId: env.sessionId,
            mcpReq: {
                id: request.id,
                method: request.method,
                _meta: request.params?._meta,
                signal: localAbort.signal,
                send: <M extends RequestMethod>(r: { method: M; params?: Record<string, unknown> }, options?: RequestOptions) =>
                    send(r as Request, options) as Promise<ResultTypeMap[M]>,
                notify: async (n: Notification) => {
                    if (done) return;
                    queue.push({ jsonrpc: '2.0', method: n.method, params: n.params } as JSONRPCNotification);
                    wake?.();
                }
            },
            http: env.authInfo || env.httpReq ? { authInfo: env.authInfo } : undefined,
            task: env.task
        };
        const ctx = this.buildContext(base, env);

        Promise.resolve()
            .then(() => handler(request, ctx))
            .then(
                result => {
                    final = localAbort.signal.aborted
                        ? errorResponse(request.id, ProtocolErrorCode.InternalError, 'Request cancelled').message
                        : { jsonrpc: '2.0', id: request.id, result };
                },
                error => {
                    final = toErrorResponse(request.id, error);
                }
            )
            .finally(() => {
                done = true;
                wake?.();
            });

        while (true) {
            while (queue.length > 0) {
                yield { kind: 'notification', message: queue.shift()! };
            }
            if (done) break;
            await new Promise<void>(resolve => {
                wake = resolve;
            });
            wake = undefined;
        }
        // Drain anything pushed between done=true and the wake.
        while (queue.length > 0) {
            yield { kind: 'notification', message: queue.shift()! };
        }
        yield { kind: 'response', message: final! };
    }

    /**
     * Envelope-agnostic dispatch for non-JSON-RPC drivers (gRPC, protobuf, REST).
     * Takes `{method, params}` directly and yields unwrapped notifications and a terminal
     * result/error. The JSON-RPC `{jsonrpc, id}` envelope is synthesized internally so
     * registered handlers (which receive `JSONRPCRequest`) work unchanged.
     *
     * @experimental Shape may change to align with SEP-1319 named param/result types.
     */
    async *dispatchRaw(
        method: string,
        params: Record<string, unknown> | undefined,
        env: DispatchEnv = {}
    ): AsyncGenerator<RawDispatchOutput, void, void> {
        const synthetic: JSONRPCRequest = { jsonrpc: '2.0', id: 0, method, params };
        for await (const out of this.dispatch(synthetic, env)) {
            if (out.kind === 'notification') {
                yield { kind: 'notification', method: out.message.method, params: out.message.params };
            } else if ('result' in out.message) {
                yield { kind: 'result', result: out.message.result };
            } else {
                yield { kind: 'error', ...out.message.error };
            }
        }
    }

    /**
     * Dispatch one inbound notification to its handler. Errors are reported via the
     * returned promise; unknown methods are silently ignored.
     */
    async dispatchNotification(notification: JSONRPCNotification): Promise<void> {
        const handler = this._notificationHandlers.get(notification.method) ?? this.fallbackNotificationHandler;
        if (handler === undefined) return;
        await Promise.resolve().then(() => handler(notification));
    }

    /**
     * Registers a handler to invoke when this dispatcher receives a request with the given method.
     */
    setRequestHandler<M extends RequestMethod>(
        method: M,
        handler: (request: RequestTypeMap[M], ctx: ContextT) => Result | Promise<Result>
    ): void {
        const schema = getRequestSchema(method);
        this._requestHandlers.set(method, (request, ctx) => {
            const parsed = schema.parse(request) as RequestTypeMap[M];
            return Promise.resolve(handler(parsed, ctx));
        });
    }

    /** Registers a raw handler with no schema parsing. Used for compat shims. */
    setRawRequestHandler(method: string, handler: RawHandler<ContextT>): void {
        this._requestHandlers.set(method, handler);
    }

    removeRequestHandler(method: string): void {
        this._requestHandlers.delete(method);
    }

    assertCanSetRequestHandler(method: string): void {
        if (this._requestHandlers.has(method)) {
            throw new Error(`A request handler for ${method} already exists, which would be overridden`);
        }
    }

    setNotificationHandler<M extends NotificationMethod>(
        method: M,
        handler: (notification: NotificationTypeMap[M]) => void | Promise<void>
    ): void {
        const schema = getNotificationSchema(method);
        this._notificationHandlers.set(method, notification => {
            const parsed = schema.parse(notification);
            return Promise.resolve(handler(parsed));
        });
    }

    removeNotificationHandler(method: string): void {
        this._notificationHandlers.delete(method);
    }

    /** Convenience: collect a full dispatch into a single response, discarding notifications. */
    async dispatchToResponse(request: JSONRPCRequest, env?: DispatchEnv): Promise<JSONRPCResponse | JSONRPCErrorResponse> {
        let resp: JSONRPCResponse | JSONRPCErrorResponse | undefined;
        for await (const out of this.dispatch(request, env)) {
            if (out.kind === 'response') resp = out.message;
        }
        return resp!;
    }
}

function errorResponse(id: RequestId, code: number, message: string): { kind: 'response'; message: JSONRPCErrorResponse } {
    return { kind: 'response', message: { jsonrpc: '2.0', id, error: { code, message } } };
}

function toErrorResponse(id: RequestId, error: unknown): JSONRPCErrorResponse {
    const e = error as { code?: unknown; message?: unknown; data?: unknown };
    return {
        jsonrpc: '2.0',
        id,
        error: {
            code: Number.isSafeInteger(e?.code) ? (e.code as number) : ProtocolErrorCode.InternalError,
            message: typeof e?.message === 'string' ? e.message : 'Internal error',
            ...(e?.data !== undefined && { data: e.data })
        }
    };
}

/** Re-export for convenience; the canonical definition lives in protocol.ts for now. */
// BaseContext / RequestOptions are exported from protocol.ts via the core barrel.
