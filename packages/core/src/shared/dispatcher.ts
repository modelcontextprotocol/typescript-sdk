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
import { getNotificationSchema, getRequestSchema, getResultSchema, ProtocolError, ProtocolErrorCode } from '../types/index.js';
import type { StandardSchemaV1 } from '../util/standardSchema.js';
import { validateStandardSchema } from '../util/standardSchema.js';
import type { RequestEnv } from './context.js';
import type { BaseContext, RequestOptions } from './protocol.js';

/**
 * One yielded item from {@linkcode Dispatcher.dispatch}. A dispatch yields zero or more
 * notifications followed by exactly one terminal response.
 *
 * @internal
 */
export type DispatchOutput =
    | { kind: 'notification'; message: JSONRPCNotification }
    | { kind: 'response'; message: JSONRPCResponse | JSONRPCErrorResponse };

/** @internal */
export type RawHandler<ContextT> = (request: JSONRPCRequest, ctx: ContextT) => Promise<Result>;

/** Signature of {@linkcode Dispatcher.dispatch}. Target type for {@linkcode DispatchMiddleware}. @internal */
export type DispatchFn = (req: JSONRPCRequest, env?: RequestEnv) => AsyncGenerator<DispatchOutput, void, void>;

/**
 * Onion-style middleware around {@linkcode Dispatcher.dispatch}. Registered via
 * {@linkcode Dispatcher.use}; composed outermost-first (registration order).
 *
 * A middleware may transform `req`/`env` before delegating, transform or filter
 * yielded outputs, or short-circuit by yielding a response without calling `next`.
 *
 * @internal
 */
export type DispatchMiddleware = (next: DispatchFn) => DispatchFn;

/**
 * Derives the handler return type for the 3-arg `setRequestHandler` form from its
 * `result` schema, defaulting to {@linkcode Result} when no schema is supplied.
 *
 * @internal
 */
export type DispatcherInferResult<R extends StandardSchemaV1 | undefined> = R extends StandardSchemaV1
    ? StandardSchemaV1.InferOutput<R>
    : Result;

/**
 * Options for constructing a {@linkcode Dispatcher}.
 *
 * @internal
 */
export type DispatcherOptions<ContextT extends BaseContext> = {
    /**
     * Enriches the base context for the owner's specific role (server/client).
     * Receives the base context the dispatcher built plus the {@linkcode RequestEnv}
     * the adapter supplied. Default returns the base unchanged.
     */
    buildContext?: (base: BaseContext, env: RequestEnv) => ContextT;

    /**
     * Wraps every registered request handler with role-specific validation
     * (e.g. capability checks). Runs for both the 2-arg and 3-arg registration
     * paths. Default is identity.
     */
    wrapHandler?: (method: string, handler: RawHandler<ContextT>) => RawHandler<ContextT>;
};

/**
 * Stateless JSON-RPC handler registry with a request-in / messages-out
 * {@linkcode Dispatcher.dispatch | dispatch()} entry point.
 *
 * Holds no transport, no correlation state, no timers. One instance can serve
 * any number of concurrent requests from any driver.
 *
 * @internal
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

    constructor(private _options: DispatcherOptions<ContextT> = {}) {}

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
     * The handler lookup + invocation. Middleware composes around this; owners do
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
        const onEnvAbort = () => localAbort.abort(env.signal!.reason);
        if (env.signal) {
            if (env.signal.aborted) localAbort.abort(env.signal.reason);
            else env.signal.addEventListener('abort', onEnvAbort, { once: true });
        }

        const send =
            env.send ??
            (async () => {
                throw new SdkError(SdkErrorCode.NotConnected, 'No outbound channel: ctx.mcpReq.send requires a connected peer');
            });

        const base: BaseContext = {
            sessionId: env.sessionId,
            mcpReq: {
                id: request.id,
                method: request.method,
                _meta: request.params?._meta,
                signal: localAbort.signal,
                send: (async (r: Request, schemaOrOptions?: unknown, maybeOptions?: RequestOptions) => {
                    const isSchema = schemaOrOptions != null && typeof schemaOrOptions === 'object' && '~standard' in schemaOrOptions;
                    const options = isSchema ? maybeOptions : (schemaOrOptions as RequestOptions | undefined);
                    const resultSchema = isSchema ? (schemaOrOptions as StandardSchemaV1) : getResultSchema(r.method as RequestMethod);
                    if (!resultSchema) {
                        throw new TypeError(
                            `'${r.method}' is not a spec method; pass a result schema as the second argument to ctx.mcpReq.send().`
                        );
                    }
                    // Thread the dispatch-local abort so env.send sinks (e.g. BackchannelCompat) see
                    // cancellation when the inbound request is aborted, instead of waiting for their own timeout.
                    const result = await send(r, { ...options, signal: options?.signal ?? localAbort.signal });
                    const parsed = await validateStandardSchema(resultSchema, result);
                    if (!parsed.success) {
                        throw new SdkError(SdkErrorCode.InvalidResult, `Invalid result for ${r.method}: ${parsed.error}`);
                    }
                    return parsed.data;
                }) as BaseContext['mcpReq']['send'],
                notify: async (n: Notification) => {
                    if (done) return;
                    queue.push({ jsonrpc: '2.0', method: n.method, params: n.params } as JSONRPCNotification);
                    wake?.();
                }
            },
            http: env.authInfo || env.httpReq ? { authInfo: env.authInfo } : undefined,
            ext: env.ext
        };
        const ctx = this._options.buildContext ? this._options.buildContext(base, env) : (base as ContextT);

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

        try {
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
        } finally {
            // Consumer broke early (generator.return()): tell the still-running handler to stop
            // and detach the env.signal listener so a long-lived caller signal doesn't leak.
            if (!done) localAbort.abort(new SdkError(SdkErrorCode.ConnectionClosed, 'dispatch consumer closed'));
            env.signal?.removeEventListener('abort', onEnvAbort);
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
     *
     * Note that this will replace any previous request handler for the same method.
     *
     * For spec methods, pass `(method, handler)`; the request is parsed with the spec
     * schema and the handler receives the typed `Request`. For custom (non-spec)
     * methods, pass `(method, schemas, handler)`; `params` are validated against
     * `schemas.params` and the handler receives the parsed params object directly.
     * Supplying `schemas.result` types the handler's return value.
     */
    setRequestHandler<M extends RequestMethod>(
        method: M,
        handler: (request: RequestTypeMap[M], ctx: ContextT) => ResultTypeMap[M] | Promise<ResultTypeMap[M]>
    ): void;
    setRequestHandler<P extends StandardSchemaV1, R extends StandardSchemaV1 | undefined = undefined>(
        method: string,
        schemas: { params: P; result?: R },
        handler: (params: StandardSchemaV1.InferOutput<P>, ctx: ContextT) => DispatcherInferResult<R> | Promise<DispatcherInferResult<R>>
    ): void;
    setRequestHandler(method: string, schemasOrHandler: unknown, maybeHandler?: unknown): void {
        let stored: RawHandler<ContextT>;

        if (maybeHandler === undefined) {
            const handler = schemasOrHandler as (request: unknown, ctx: ContextT) => Result | Promise<Result>;
            const schema = getRequestSchema(method as RequestMethod);
            if (!schema) {
                throw new TypeError(
                    `'${method}' is not a spec request method; pass schemas as the second argument to setRequestHandler().`
                );
            }
            stored = (request, ctx) => {
                const parsed = schema.parse(request);
                return Promise.resolve(handler(parsed, ctx));
            };
        } else {
            const schemas = schemasOrHandler as { params: StandardSchemaV1 };
            const handler = maybeHandler as (params: unknown, ctx: ContextT) => Result | Promise<Result>;
            stored = async (request, ctx) => {
                const userParams = { ...((request.params ?? {}) as Record<string, unknown>) };
                delete userParams._meta;
                const parsed = await validateStandardSchema(schemas.params, userParams);
                if (!parsed.success) {
                    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid params for ${method}: ${parsed.error}`);
                }
                return handler(parsed.data, ctx);
            };
        }

        const wrap = this._options.wrapHandler ?? ((_m, h) => h);
        this._requestHandlers.set(method, wrap(method, stored));
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

    /**
     * Registers a handler to invoke when this dispatcher receives a notification with the given method.
     *
     * Note that this will replace any previous notification handler for the same method.
     *
     * For spec methods, pass `(method, handler)`; the notification is parsed with the
     * spec schema. For custom (non-spec) methods, pass `(method, schemas, handler)`;
     * `params` are validated against `schemas.params` and the handler receives the
     * parsed params object directly.
     */
    setNotificationHandler<M extends NotificationMethod>(
        method: M,
        handler: (notification: NotificationTypeMap[M]) => void | Promise<void>
    ): void;
    setNotificationHandler<P extends StandardSchemaV1>(
        method: string,
        schemas: { params: P },
        handler: (params: StandardSchemaV1.InferOutput<P>, notification: Notification) => void | Promise<void>
    ): void;
    setNotificationHandler(method: string, schemasOrHandler: unknown, maybeHandler?: unknown): void {
        if (maybeHandler !== undefined) {
            const schemas = schemasOrHandler as { params: StandardSchemaV1 };
            const handler = maybeHandler as (params: unknown, notification: Notification) => void | Promise<void>;
            this._notificationHandlers.set(method, async notification => {
                const userParams = { ...((notification.params ?? {}) as Record<string, unknown>) };
                delete userParams._meta;
                const parsed = await validateStandardSchema(schemas.params, userParams);
                if (!parsed.success) {
                    throw new Error(`Invalid params for notification ${method}: ${parsed.error}`);
                }
                await handler(parsed.data, notification);
            });
            return;
        }

        const handler = schemasOrHandler as (notification: unknown) => void | Promise<void>;
        const schema = getNotificationSchema(method as NotificationMethod);
        if (!schema) {
            throw new TypeError(
                `'${method}' is not a spec notification method; pass schemas as the second argument to setNotificationHandler().`
            );
        }
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
