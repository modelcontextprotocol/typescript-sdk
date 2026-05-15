import type {
    ClientCapabilities,
    JSONRPCNotification,
    JSONRPCRequest,
    Notification,
    NotificationMethod,
    NotificationTypeMap,
    RequestMethod,
    RequestTypeMap,
    Result,
    ResultTypeMap,
    ServerCapabilities
} from '../types/index.js';
import { getNotificationSchema, getRequestSchema, ProtocolError, ProtocolErrorCode } from '../types/index.js';
import type { StandardSchemaV1 } from '../util/standardSchema.js';
import { validateStandardSchema } from '../util/standardSchema.js';
import type { BaseContext } from './protocol.js';

/**
 * A function that handles an incoming JSON-RPC request and returns a result.
 */
export type RequestHandler<ContextT extends BaseContext> = (request: JSONRPCRequest, ctx: ContextT) => Promise<Result>;

/**
 * A function that handles an incoming JSON-RPC notification.
 */
export type NotificationHandler = (notification: JSONRPCNotification) => Promise<void>;

/**
 * Schema bundle accepted by {@linkcode HandlerRegistry.setRequestHandler | setRequestHandler}'s 3-arg form.
 *
 * `params` is required and validates the inbound `request.params`. `result` is optional;
 * when supplied it types the handler's return value (no runtime validation is performed
 * on the result).
 */
export interface RequestHandlerSchemas<
    P extends StandardSchemaV1 = StandardSchemaV1,
    R extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined
> {
    params: P;
    result?: R;
}

/**
 * Infers the handler return type from an optional result schema.
 * When `R` is a `StandardSchemaV1`, the return type is the schema's output type.
 * When `R` is `undefined`, the return type falls back to the generic `Result`.
 */
export type InferHandlerResult<R extends StandardSchemaV1 | undefined> = R extends StandardSchemaV1
    ? StandardSchemaV1.InferOutput<R>
    : Result;

/**
 * Options for constructing a {@linkcode HandlerRegistry}.
 */
export interface HandlerRegistryOptions<ContextT extends BaseContext, Caps extends ServerCapabilities | ClientCapabilities> {
    /**
     * Initial capabilities. These are shallow-merged with any capabilities
     * registered later via {@linkcode HandlerRegistry.registerCapabilities | registerCapabilities()}.
     */
    capabilities?: Caps;

    /**
     * Optional callback invoked during {@linkcode HandlerRegistry.setRequestHandler | setRequestHandler()}
     * to assert that registering a handler for this method is valid given the
     * declared capabilities. For example, a server may reject handler registration
     * for `tools/call` unless `capabilities.tools` is declared.
     */
    assertRequestHandlerCapability?: (method: string) => void;

    /**
     * Optional callback that wraps every registered request handler with
     * role-specific validation or behavior (e.g., `Server` validates `tools/call`
     * results). The default behavior is identity (no wrapping).
     */
    wrapHandler?: (method: string, handler: RequestHandler<ContextT>) => RequestHandler<ContextT>;
}

/**
 * Owns handler maps, schema parsing, and capability management.
 *
 * `HandlerRegistry` is a standalone class extracted from `Protocol` so that
 * multiple protocol instances (or routers) can share or compose handler sets
 * without being coupled to transport or connection lifecycle.
 */
export class HandlerRegistry<ContextT extends BaseContext, Caps extends ServerCapabilities | ClientCapabilities> {
    private _requestHandlers: Map<string, RequestHandler<ContextT>> = new Map();
    private _notificationHandlers: Map<string, NotificationHandler> = new Map();
    private _capabilities: Caps;
    assertRequestHandlerCapability?: (method: string) => void;
    wrapHandler?: (method: string, handler: RequestHandler<ContextT>) => RequestHandler<ContextT>;

    /**
     * A handler to invoke for any request types that do not have their own handler installed.
     */
    fallbackRequestHandler?: RequestHandler<ContextT>;

    /**
     * A handler to invoke for any notification types that do not have their own handler installed.
     */
    fallbackNotificationHandler?: (notification: Notification) => Promise<void>;

    constructor(options?: HandlerRegistryOptions<ContextT, Caps>) {
        this._capabilities = (options?.capabilities ?? {}) as Caps;
        this.assertRequestHandlerCapability = options?.assertRequestHandlerCapability;
        this.wrapHandler = options?.wrapHandler;
    }

    /**
     * Read-only view of the registered request handlers.
     */
    get requestHandlers(): ReadonlyMap<string, RequestHandler<ContextT>> {
        return this._requestHandlers;
    }

    /**
     * Read-only view of the registered notification handlers.
     */
    get notificationHandlers(): ReadonlyMap<string, NotificationHandler> {
        return this._notificationHandlers;
    }

    // -----------------------------------------------------------------------
    // Capabilities
    // -----------------------------------------------------------------------

    /**
     * Merges additional capabilities into the existing capability set.
     */
    registerCapabilities(caps: Partial<Caps>): void {
        this._capabilities = mergeCapabilities(this._capabilities, caps) as Caps;
    }

    /**
     * Returns the current capability set.
     */
    getCapabilities(): Caps {
        return this._capabilities;
    }

    // -----------------------------------------------------------------------
    // Request handler registration
    // -----------------------------------------------------------------------

    /**
     * Registers a handler to invoke when a request with the given method is received.
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
        handler: (params: StandardSchemaV1.InferOutput<P>, ctx: ContextT) => InferHandlerResult<R> | Promise<InferHandlerResult<R>>
    ): void;
    setRequestHandler(
        method: string,
        schemasOrHandler: RequestHandlerSchemas | ((request: unknown, ctx: ContextT) => Result | Promise<Result>),
        maybeHandler?: (params: unknown, ctx: ContextT) => Result | Promise<Result>
    ): void {
        this.assertRequestHandlerCapability?.(method);

        let stored: RequestHandler<ContextT>;

        if (typeof schemasOrHandler === 'function') {
            const schema = getRequestSchema(method);
            if (!schema) {
                throw new TypeError(
                    `'${method}' is not a spec request method; pass schemas as the second argument to setRequestHandler().`
                );
            }
            stored = (request, ctx) => Promise.resolve(schemasOrHandler(schema.parse(request), ctx));
        } else if (maybeHandler) {
            stored = async (request, ctx) => {
                const userParams = { ...request.params };
                delete userParams._meta;
                const parsed = await validateStandardSchema(schemasOrHandler.params, userParams);
                if (!parsed.success) {
                    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid params for ${method}: ${parsed.error}`);
                }
                return maybeHandler(parsed.data, ctx);
            };
        } else {
            throw new TypeError('setRequestHandler: handler is required');
        }

        const wrapped = this.wrapHandler ? this.wrapHandler(method, stored) : stored;
        this._requestHandlers.set(method, wrapped);
    }

    /**
     * Removes the request handler for the given method.
     */
    removeRequestHandler(method: RequestMethod | string): void {
        this._requestHandlers.delete(method);
    }

    /**
     * Asserts that a request handler has not already been set for the given method,
     * in preparation for a new one being automatically installed.
     */
    assertCanSetRequestHandler(method: RequestMethod | string): void {
        if (this._requestHandlers.has(method)) {
            throw new Error(`A request handler for ${method} already exists, which would be overridden`);
        }
    }

    // -----------------------------------------------------------------------
    // Notification handler registration
    // -----------------------------------------------------------------------

    /**
     * Registers a handler to invoke when a notification with the given method is received.
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
        if (typeof schemasOrHandler === 'function') {
            const schema = getNotificationSchema(method);
            if (!schema) {
                throw new TypeError(
                    `'${method}' is not a spec notification method; pass schemas as the second argument to setNotificationHandler().`
                );
            }
            this._notificationHandlers.set(method, notification => Promise.resolve(schemasOrHandler(schema.parse(notification))));
            return;
        }

        if (!maybeHandler) {
            throw new TypeError('setNotificationHandler: handler is required');
        }
        this._notificationHandlers.set(method, async notification => {
            const userParams = { ...notification.params };
            delete userParams._meta;
            const parsed = await validateStandardSchema(schemasOrHandler.params, userParams);
            if (!parsed.success) {
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid params for notification ${method}: ${parsed.error}`);
            }
            await maybeHandler(parsed.data, notification);
        });
    }

    /**
     * Removes the notification handler for the given method.
     */
    removeNotificationHandler(method: NotificationMethod | string): void {
        this._notificationHandlers.delete(method);
    }
}

// ---------------------------------------------------------------------------
// Capability merging helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function mergeCapabilities(base: ServerCapabilities, additional: Partial<ServerCapabilities>): ServerCapabilities;
export function mergeCapabilities(base: ClientCapabilities, additional: Partial<ClientCapabilities>): ClientCapabilities;
export function mergeCapabilities<T extends ServerCapabilities | ClientCapabilities>(base: T, additional: Partial<T>): T {
    const result: T = { ...base };
    for (const key in additional) {
        const k = key as keyof T;
        const addValue = additional[k];
        if (addValue === undefined) continue;
        const baseValue = result[k];
        result[k] =
            isPlainObject(baseValue) && isPlainObject(addValue)
                ? ({ ...(baseValue as Record<string, unknown>), ...(addValue as Record<string, unknown>) } as T[typeof k])
                : (addValue as T[typeof k]);
    }
    return result;
}
