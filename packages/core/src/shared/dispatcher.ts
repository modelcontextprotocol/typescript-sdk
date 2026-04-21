import { SdkError, SdkErrorCode } from '../errors/sdkErrors.js';
import type {
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
import { getNotificationSchema, getRequestSchema, ProtocolError, ProtocolErrorCode } from '../types/index.js';
import type { StandardSchemaV1 } from '../util/standardSchema.js';
import type { BaseContext, RequestEnv, RequestOptions } from './context.js';

/** @deprecated Renamed to {@linkcode RequestEnv} (now in `context.ts`). */
export type DispatchEnv = RequestEnv;

/**
 * One yielded item from {@linkcode Dispatcher.dispatch}. A dispatch yields zero or more
 * notifications followed by exactly one terminal response.
 */
export type DispatchOutput =
    | { kind: 'notification'; message: JSONRPCNotification }
    | { kind: 'response'; message: JSONRPCResponse | JSONRPCErrorResponse };

type RawHandler<ContextT> = (request: JSONRPCRequest, ctx: ContextT) => Promise<Result>;

/** Signature of {@linkcode Dispatcher.dispatch}. Target type for {@linkcode DispatchMiddleware}. */
export type DispatchFn = (req: JSONRPCRequest, env?: RequestEnv) => AsyncGenerator<DispatchOutput, void, void>;

/**
 * Onion-style middleware around {@linkcode Dispatcher.dispatch}. Registered via
 * {@linkcode Dispatcher.use}; composed outermost-first (registration order).
 *
 * A middleware may transform `req`/`env` before delegating, transform or filter
 * yielded outputs, or short-circuit by yielding a response without calling `next`.
 */
export type DispatchMiddleware = (next: DispatchFn) => DispatchFn;

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
    private _dispatchMw: DispatchMiddleware[] = [];

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
    protected buildContext(base: BaseContext, _env: RequestEnv): ContextT {
        return base as ContextT;
    }

    /**
     * Registers a {@linkcode DispatchMiddleware}. Registration order is outer-to-inner:
     * the first middleware registered sees the rawest request and the final yields.
     */
    use(mw: DispatchMiddleware): this {
        this._dispatchMw.push(mw);
        return this;
    }

    /**
     * Dispatch one inbound request through the registered middleware chain, then the
     * core handler lookup. Yields any notifications the handler emits via
     * `ctx.mcpReq.notify()`, then yields exactly one terminal response.
     *
     * Never throws for handler errors; they are wrapped as JSON-RPC error responses.
     * May throw if iteration itself is misused.
     */
    dispatch(request: JSONRPCRequest, env: RequestEnv = {}): AsyncGenerator<DispatchOutput, void, void> {
        // eslint-disable-next-line unicorn/consistent-function-scoping -- closes over `this`
        let chain: DispatchFn = (r, e) => this._dispatchCore(r, e);
        // eslint-disable-next-line unicorn/no-array-reverse -- toReversed() requires ES2023 lib; consumers may target ES2022
        for (const mw of [...this._dispatchMw].reverse()) chain = mw(chain);
        return chain(request, env);
    }

    /**
     * The handler lookup + invocation. Middleware composes around this; subclasses do
     * not override `dispatch()` directly — use {@linkcode Dispatcher.use | use()} instead.
     */
    private async *_dispatchCore(request: JSONRPCRequest, env: RequestEnv = {}): AsyncGenerator<DispatchOutput, void, void> {
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
     *
     * For spec methods, the request is parsed against the spec schema and the handler receives
     * the typed `RequestTypeMap[M]`.
     */
    setRequestHandler<M extends RequestMethod>(
        method: M,
        handler: (request: RequestTypeMap[M], ctx: ContextT) => Result | Promise<Result>
    ): void;
    /**
     * Registers a handler for a custom (non-spec) method. The provided `paramsSchema` validates
     * `request.params` (with `_meta` stripped); the handler receives the parsed params object.
     */
    setRequestHandler<S extends StandardSchemaV1>(
        method: string,
        paramsSchema: S,
        handler: (params: StandardSchemaV1.InferOutput<S>, ctx: ContextT) => Result | Promise<Result>
    ): void;
    setRequestHandler(method: string, schemaOrHandler: unknown, maybeHandler?: unknown): void {
        if (maybeHandler !== undefined) {
            const userHandler = maybeHandler as (params: unknown, ctx: ContextT) => Result | Promise<Result>;
            this._requestHandlers.set(method, this._wrapParamsSchemaHandler(method, schemaOrHandler as StandardSchemaV1, userHandler));
            return;
        }
        const handler = schemaOrHandler as (request: unknown, ctx: ContextT) => Result | Promise<Result>;
        const schema = getRequestSchema(method as RequestMethod);
        this._requestHandlers.set(method, (request, ctx) => {
            const parsed = schema.parse(request);
            return Promise.resolve(handler(parsed, ctx));
        });
    }

    /**
     * Builds a raw handler that validates `request.params` (minus `_meta`) against `paramsSchema`
     * and invokes `handler(parsedParams, ctx)`. Shared with subclass overrides so per-method
     * wrapping composes uniformly with the 3-arg form.
     */
    protected _wrapParamsSchemaHandler(
        method: string,
        paramsSchema: StandardSchemaV1,
        handler: (params: unknown, ctx: ContextT) => Result | Promise<Result>
    ): RawHandler<ContextT> {
        return async (request, ctx) => {
            const { _meta, ...userParams } = (request.params ?? {}) as Record<string, unknown>;
            void _meta;
            const parsed = await paramsSchema['~standard'].validate(userParams);
            if (parsed.issues) {
                const msg = parsed.issues.map(i => i.message).join('; ');
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid params for ${method}: ${msg}`);
            }
            return handler(parsed.value, ctx);
        };
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
    async dispatchToResponse(request: JSONRPCRequest, env?: RequestEnv): Promise<JSONRPCResponse | JSONRPCErrorResponse> {
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
