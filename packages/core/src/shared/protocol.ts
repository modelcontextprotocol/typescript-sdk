/**
 * The {@linkcode Protocol} class composes a stateless {@linkcode Dispatcher}
 * (handler registry + dispatch) and a per-connection {@linkcode StreamDriver}
 * (id correlation, timeouts, progress) under the same public surface as before.
 * Handler-context types live in `./context.ts` and are re-exported here for
 * backward-compatible import paths.
 */

import { SdkError, SdkErrorCode } from '../errors/sdkErrors.js';
import type {
    JSONRPCNotification,
    JSONRPCRequest,
    MessageExtraInfo,
    Notification,
    NotificationMethod,
    NotificationTypeMap,
    Request,
    RequestMethod,
    RequestTypeMap,
    Result,
    ResultTypeMap
} from '../types/index.js';
import { getResultSchema, SUPPORTED_PROTOCOL_VERSIONS } from '../types/index.js';
import type { StandardSchemaV1 } from '../util/standardSchema.js';
import { isStandardSchema } from '../util/standardSchema.js';
import type { BaseContext, NotificationOptions, ProtocolOptions, RequestEnv, RequestHandlerSchemas, RequestOptions } from './context.js';
import type { DispatchMiddleware, DispatchOutput, RawHandler } from './dispatcher.js';
import { Dispatcher } from './dispatcher.js';
import { RAW_RESULT_SCHEMA, StreamDriver } from './streamDriver.js';
import type { Transport } from './transport.js';

export * from './context.js';

type InferHandlerResult<R extends StandardSchemaV1 | undefined> = R extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<R> : Result;

/** Type-erased forwarding signature for the {@linkcode Dispatcher.setRequestHandler} overload set. */
type SetRequestHandlerImpl<ContextT> = (
    method: string,
    schemaOrHandler: unknown,
    maybeHandler?: (params: unknown, ctx: ContextT) => Result | Promise<Result>
) => void;

/** Type-erased forwarding signature for the {@linkcode Dispatcher.setNotificationHandler} overload set. */
type SetNotificationHandlerImpl = (
    method: string,
    schemaOrHandler: unknown,
    maybeHandler?: (params: unknown, notification: Notification) => void | Promise<void>
) => void;

/** RequestEnv augmented with the per-request fields {@linkcode Protocol} threads through. */
type ProtocolEnv = RequestEnv & {
    /** {@linkcode MessageExtraInfo} captured by the transport, forwarded to {@linkcode Protocol.buildContext}. */
    _transportExtra?: MessageExtraInfo;
};

/**
 * Implements MCP protocol framing on top of a pluggable transport, including
 * features like request/response linking, notifications, and progress.
 *
 * `Protocol` is abstract; `Client` and `Server` are the concrete role-specific
 * implementations most code should use.
 */
export abstract class Protocol<ContextT extends BaseContext> {
    private readonly _dispatcher: Dispatcher<ContextT>;
    private _driver?: StreamDriver;

    protected _supportedProtocolVersions: string[];

    /**
     * Callback for when the connection is closed for any reason.
     *
     * This is invoked when {@linkcode Protocol.close | close()} is called as well.
     */
    onclose?: () => void;

    /**
     * Callback for when an error occurs.
     *
     * Note that errors are not necessarily fatal; they are used for reporting any kind of exceptional condition out of band.
     */
    onerror?: (error: Error) => void;

    constructor(private _options?: ProtocolOptions) {
        this._dispatcher = new Dispatcher<ContextT>({
            buildContext: (base, env) => this.buildContext(base, (env as ProtocolEnv)._transportExtra),
            wrapHandler: (method, handler) => this._wrapHandler(method, handler)
        });
        this._supportedProtocolVersions = _options?.supportedProtocolVersions ?? SUPPORTED_PROTOCOL_VERSIONS;

        this.setNotificationHandler('notifications/cancelled', () => {});
        this.setNotificationHandler('notifications/progress', () => {});
        this.setRequestHandler('ping', _request => ({}) as Result);
    }

    // ───────────────────────────────────────────────────────────────────────
    // Subclass hooks (abstract)
    // ───────────────────────────────────────────────────────────────────────

    /**
     * Builds the context object for request handlers. Subclasses must override
     * to return the appropriate context type (e.g., ServerContext adds HTTP request info).
     */
    protected abstract buildContext(ctx: BaseContext, transportInfo?: MessageExtraInfo): ContextT;

    /**
     * A method to check if a capability is supported by the remote side, for the given method to be called.
     *
     * This should be implemented by subclasses.
     */
    protected abstract assertCapabilityForMethod(method: RequestMethod | string): void;

    /**
     * A method to check if a notification is supported by the local side, for the given method to be sent.
     *
     * This should be implemented by subclasses.
     */
    protected abstract assertNotificationCapability(method: NotificationMethod | string): void;

    /**
     * A method to check if a request handler is supported by the local side, for the given method to be handled.
     *
     * This should be implemented by subclasses.
     */
    protected abstract assertRequestHandlerCapability(method: string): void;

    // ───────────────────────────────────────────────────────────────────────
    // Handler registration (delegates to Dispatcher)
    // ───────────────────────────────────────────────────────────────────────

    /**
     * A handler to invoke for any request types that do not have their own handler installed.
     */
    get fallbackRequestHandler(): ((request: JSONRPCRequest, ctx: ContextT) => Promise<Result>) | undefined {
        return this._dispatcher.fallbackRequestHandler;
    }
    set fallbackRequestHandler(h) {
        this._dispatcher.fallbackRequestHandler = h;
    }

    /**
     * A handler to invoke for any notification types that do not have their own handler installed.
     */
    get fallbackNotificationHandler(): ((notification: Notification) => Promise<void>) | undefined {
        return this._dispatcher.fallbackNotificationHandler;
    }
    set fallbackNotificationHandler(h) {
        this._dispatcher.fallbackNotificationHandler = h;
    }

    /**
     * Registers a {@linkcode DispatchMiddleware} around the inbound request path.
     * Registration order is outer-to-inner: the first `use()` call wraps all later ones.
     */
    use(mw: DispatchMiddleware): this {
        this._dispatcher.use(mw);
        return this;
    }

    /**
     * Dispatch one inbound request through the middleware chain and registered handler,
     * yielding any handler-emitted notifications then exactly one terminal response.
     * Transport-free entry point; `env` carries per-request input from the caller.
     */
    dispatch(request: JSONRPCRequest, env?: RequestEnv): AsyncGenerator<DispatchOutput, void, void> {
        return this._dispatcher.dispatch(request, env);
    }

    /**
     * Dispatch one inbound notification to its registered handler. Transport-free
     * counterpart to {@linkcode Protocol.dispatch}; consumed by `handleHttp`.
     */
    dispatchNotification(notification: JSONRPCNotification): Promise<void> {
        return this._dispatcher.dispatchNotification(notification);
    }

    /**
     * Registers a handler to invoke when this protocol object receives a request with the given method.
     *
     * Note that this will replace any previous request handler for the same method.
     *
     * For spec methods, pass `(method, handler)`; the request is parsed with the spec
     * schema and the handler receives the typed `Request`. For custom (non-spec)
     * methods, pass `(method, schemas, handler)`; `params` are validated against
     * `schemas.params` and the handler receives the parsed params object directly.
     * Supplying `schemas.result` types the handler's return value.
     *
     * @example Custom request method
     * ```ts source="./protocol.examples.ts#Protocol_setRequestHandler_customMethod"
     * const SearchParams = z.object({ query: z.string(), limit: z.number().optional() });
     * const SearchResult = z.object({ hits: z.array(z.string()) });
     *
     * protocol.setRequestHandler('acme/search', { params: SearchParams, result: SearchResult }, async (params, _ctx) => {
     *     return { hits: [`result for ${params.query}`] };
     * });
     * ```
     */
    setRequestHandler<M extends RequestMethod>(
        method: M,
        handler: (request: RequestTypeMap[M], ctx: ContextT) => ResultTypeMap[M] | Promise<ResultTypeMap[M]>
    ): void;
    setRequestHandler<P extends StandardSchemaV1, R extends StandardSchemaV1 | undefined = undefined>(
        method: string,
        schemas: { params: P; result?: R },
        handler: (params: StandardSchemaV1.InferOutput<P>, ctx: ContextT) => InferHandlerResult<R> | Promise<InferHandlerResult<R>>
    ): void;
    setRequestHandler(
        method: string,
        schemasOrHandler: RequestHandlerSchemas | ((request: unknown, ctx: ContextT) => Result | Promise<Result>),
        maybeHandler?: (params: unknown, ctx: ContextT) => Result | Promise<Result>
    ): void {
        this.assertRequestHandlerCapability(method);
        (this._dispatcher.setRequestHandler as SetRequestHandlerImpl<ContextT>)(method, schemasOrHandler, maybeHandler);
    }

    /**
     * Hook for subclasses to wrap a registered request handler with role-specific
     * validation or behavior (e.g. `Server` validates `tools/call` results, `Client`
     * validates `elicitation/create` mode and result). Runs for both the 2-arg and
     * 3-arg registration paths. The default implementation is identity.
     *
     * Subclasses overriding this hook avoid redeclaring `setRequestHandler`'s overload set.
     */
    protected _wrapHandler(_method: string, handler: RawHandler<ContextT>): RawHandler<ContextT> {
        return handler;
    }

    /**
     * Removes the request handler for the given method.
     */
    removeRequestHandler(method: RequestMethod | string): void {
        this._dispatcher.removeRequestHandler(method);
    }

    /**
     * Asserts that a request handler has not already been set for the given method, in preparation for a new one being automatically installed.
     */
    assertCanSetRequestHandler(method: RequestMethod | string): void {
        this._dispatcher.assertCanSetRequestHandler(method);
    }

    /**
     * Registers a handler to invoke when this protocol object receives a notification with the given method.
     *
     * Note that this will replace any previous notification handler for the same method.
     *
     * For spec methods, pass `(method, handler)`; the notification is parsed with the
     * spec schema. For custom (non-spec) methods, pass `(method, schemas, handler)`;
     * `params` are validated against `schemas.params` and the handler receives the
     * parsed params object directly. The raw notification is passed as the second
     * argument; `_meta` is recoverable via `notification.params?._meta`.
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
    setNotificationHandler(
        method: string,
        schemasOrHandler: { params: StandardSchemaV1 } | ((notification: unknown) => void | Promise<void>),
        maybeHandler?: (params: unknown, notification: Notification) => void | Promise<void>
    ): void {
        (this._dispatcher.setNotificationHandler as SetNotificationHandlerImpl)(method, schemasOrHandler, maybeHandler);
    }

    /**
     * Removes the notification handler for the given method.
     */
    removeNotificationHandler(method: NotificationMethod | string): void {
        this._dispatcher.removeNotificationHandler(method);
    }

    // ───────────────────────────────────────────────────────────────────────
    // Connection (delegates to StreamDriver)
    // ───────────────────────────────────────────────────────────────────────

    get transport(): Transport | undefined {
        return this._driver?.pipe;
    }

    /**
     * @deprecated Compat shim for tests that introspect this private map.
     * The map lives on {@linkcode StreamDriver} now.
     * @internal
     */
    /**
     * Attaches to the given transport, starts it, and starts listening for messages.
     *
     * The caller assumes ownership of the {@linkcode Transport}, replacing any callbacks that have already been set, and expects that it is the only user of the {@linkcode Transport} instance going forward.
     */
    async connect(transport: Transport): Promise<void> {
        const driver = new StreamDriver(this._dispatcher, transport, {
            supportedProtocolVersions: this._supportedProtocolVersions,
            debouncedNotificationMethods: this._options?.debouncedNotificationMethods,
            buildEnv: (extra, base) => {
                const env: ProtocolEnv = {
                    ...base,
                    _transportExtra: extra,
                    notify: (n: Notification) => this.notification(n, { relatedRequestId: base.relatedRequestId }),
                    send: (r, opts) => this._requestWithSchema(r, RAW_RESULT_SCHEMA, { ...opts, relatedRequestId: base.relatedRequestId })
                };
                return env;
            }
        });
        this._driver = driver;

        driver.onclose = () => {
            if (this._driver === driver) {
                this._driver = undefined;
                this.onclose?.();
            }
        };
        driver.onerror = error => this.onerror?.(error);

        await driver.start();
    }

    /**
     * Closes the connection.
     */
    async close(): Promise<void> {
        await this._driver?.close();
    }

    /**
     * Sends a request and waits for a response.
     *
     * For spec methods the result schema is resolved automatically from the method name
     * and the return type is method-keyed. For custom (non-spec) methods, pass a
     * `resultSchema` as the second argument; the response is validated against it and
     * the return type is inferred from the schema.
     *
     * Do not use this method to emit notifications! Use {@linkcode Protocol.notification | notification()} instead.
     */
    request<M extends RequestMethod>(
        request: { method: M; params?: Record<string, unknown> },
        options?: RequestOptions
    ): Promise<ResultTypeMap[M]>;
    request<T extends StandardSchemaV1>(
        request: Request,
        resultSchema: T,
        options?: RequestOptions
    ): Promise<StandardSchemaV1.InferOutput<T>>;
    request(request: Request, schemaOrOptions?: StandardSchemaV1 | RequestOptions, maybeOptions?: RequestOptions): Promise<unknown> {
        if (isStandardSchema(schemaOrOptions)) {
            return this._requestWithSchema(request, schemaOrOptions, maybeOptions);
        }
        const resultSchema = getResultSchema(request.method);
        if (!resultSchema) {
            throw new TypeError(`'${request.method}' is not a spec method; pass a result schema as the second argument to request().`);
        }
        return this._requestWithSchema(request, resultSchema, schemaOrOptions);
    }

    /**
     * Sends a request and waits for a response, using the provided schema for validation.
     *
     * This is the internal implementation used by SDK methods that need to specify
     * a particular result schema (e.g., for compatibility or task-specific schemas).
     */
    protected _requestWithSchema<T extends StandardSchemaV1>(
        request: Request,
        resultSchema: T,
        options?: RequestOptions
    ): Promise<StandardSchemaV1.InferOutput<T>> {
        if (!this._driver) {
            return Promise.reject(new Error('Not connected'));
        }
        if (this._options?.enforceStrictCapabilities === true) {
            try {
                this.assertCapabilityForMethod(request.method as RequestMethod);
            } catch (error) {
                return Promise.reject(error);
            }
        }
        return this._driver.request(request, resultSchema, options);
    }

    /**
     * Emits a notification, which is a one-way message that does not expect a response.
     */
    async notification(notification: Notification, options?: NotificationOptions): Promise<void> {
        const driver = this._driver;
        if (!driver) {
            throw new SdkError(SdkErrorCode.NotConnected, 'Not connected');
        }
        this.assertNotificationCapability(notification.method as NotificationMethod);
        await driver.notification(notification, options);
    }
}
