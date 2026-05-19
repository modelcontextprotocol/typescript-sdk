import { ProtocolErrorCode } from '../types/enums.js';
import { ProtocolError } from '../types/errors.js';
import type {
    JSONRPCErrorResponse,
    JSONRPCRequest,
    JSONRPCResponse,
    RequestMethod,
    RequestTypeMap,
    Result,
    ResultTypeMap
} from '../types/index.js';
import { getRequestSchema, JSONRPC_VERSION } from '../types/index.js';
import type { StandardSchemaV1 } from '../util/standardSchema.js';
import { validateStandardSchema } from '../util/standardSchema.js';

/**
 * A request handler stored in {@linkcode Dispatcher}. Receives the raw JSON-RPC
 * request and a caller-supplied context, returns a `Result` (the success
 * payload). Throw {@linkcode ProtocolError} to surface a structured error.
 */
export type Handler<C> = (request: JSONRPCRequest, ctx: C) => Promise<Result>;

/**
 * Onion-style middleware around handler invocation. Receives `next` to call
 * the remaining chain (and ultimately the handler). May short-circuit by
 * returning a `Result` without calling `next`, or transform the result/error.
 *
 * Installed via {@linkcode Dispatcher.use}; runs for every request that
 * routes through {@linkcode Dispatcher.dispatch}.
 */
export type Middleware<C> = (request: JSONRPCRequest, ctx: C, next: () => Promise<Result>) => Promise<Result>;

/**
 * Schema bundle accepted by `setRequestHandler`'s 3-arg form.
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

/** Infers the handler's return type from a `RequestHandlerSchemas.result` schema (or `Result` when absent). */
export type InferHandlerResult<R extends StandardSchemaV1 | undefined> = R extends StandardSchemaV1
    ? StandardSchemaV1.InferOutput<R>
    : Result;

/**
 * Method-keyed request handler registry plus invocation. Both the legacy
 * connect/_onrequest path and the 2026-06 stateless dispatch path route
 * through {@linkcode dispatch}.
 *
 * `dispatch()` looks up the handler, runs the middleware chain, wraps the
 * result/error into a JSON-RPC response. It writes no instance state and is
 * safe to call concurrently.
 */
export class Dispatcher<ContextT> {
    private readonly _handlers = new Map<string, Handler<ContextT>>();
    private readonly _middleware: Middleware<ContextT>[] = [];

    /** Called when no specific handler matches. Not wrapped by middleware. */
    fallbackHandler?: Handler<ContextT>;

    /**
     * Appends a middleware. Middlewares run in registration order, with the
     * registered handler as the innermost call.
     */
    use(middleware: Middleware<ContextT>): void {
        this._middleware.push(middleware);
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
        handler: (params: StandardSchemaV1.InferOutput<P>, ctx: ContextT) => InferHandlerResult<R> | Promise<InferHandlerResult<R>>
    ): void;
    setRequestHandler(
        method: string,
        schemasOrHandler: RequestHandlerSchemas | ((request: unknown, ctx: ContextT) => Result | Promise<Result>),
        maybeHandler?: (params: unknown, ctx: ContextT) => Result | Promise<Result>
    ): void {
        let stored: Handler<ContextT>;

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

        this._handlers.set(method, stored);
    }

    /**
     * Removes the request handler for the given method.
     */
    removeRequestHandler(method: RequestMethod | string): void {
        this._handlers.delete(method);
    }

    /**
     * Asserts that a request handler has not already been set for the given method, in preparation for a new one being automatically installed.
     */
    assertCanSetRequestHandler(method: RequestMethod | string): void {
        if (this._handlers.has(method)) {
            throw new Error(`A request handler for ${method} already exists, which would be overridden`);
        }
    }

    /**
     * Returns true if {@linkcode dispatch} would route this method to a handler
     * (registered or fallback) rather than returning MethodNotFound.
     */
    canHandle(method: string): boolean {
        return this._handlers.has(method) || this.fallbackHandler !== undefined;
    }

    /**
     * Dispatches one JSON-RPC request through the middleware chain to its
     * handler and wraps the outcome as a JSON-RPC response.
     *
     * Thrown errors are surfaced with their `code` (if a safe integer),
     * `message`, and `data` properties. This matches the behavior of
     * `Protocol._onrequest` prior to extraction.
     */
    async dispatch(request: JSONRPCRequest, ctx: ContextT): Promise<JSONRPCResponse | JSONRPCErrorResponse> {
        const id = request.id;
        const handler = this._handlers.get(request.method);
        let chain: () => Promise<Result>;
        if (handler !== undefined) {
            chain = () => handler(request, ctx);
            for (let i = this._middleware.length - 1; i >= 0; i--) {
                // Loop bounds guarantee a defined element (noUncheckedIndexedAccess).
                const mw = this._middleware[i] as Middleware<ContextT>;
                const next = chain;
                chain = () => mw(request, ctx, next);
            }
        } else if (this.fallbackHandler === undefined) {
            return errorResponse(id, ProtocolErrorCode.MethodNotFound, 'Method not found');
        } else {
            // Preserve pre-extraction behavior: fallback bypasses middleware.
            const fb = this.fallbackHandler;
            chain = () => fb(request, ctx);
        }
        try {
            return okResponse(id, await chain());
        } catch (error) {
            const e = error as { code?: unknown; message?: string; data?: unknown };
            return errorResponse(
                id,
                Number.isSafeInteger(e.code) ? (e.code as number) : ProtocolErrorCode.InternalError,
                e.message ?? 'Internal error',
                e.data
            );
        }
    }
}

/** Builds a JSON-RPC success response. */
export function okResponse(id: JSONRPCRequest['id'], result: Result): JSONRPCResponse {
    return { jsonrpc: JSONRPC_VERSION, id, result };
}

/** Builds a JSON-RPC error response. */
export function errorResponse(id: JSONRPCRequest['id'], code: number, message: string, data?: unknown): JSONRPCErrorResponse {
    return { jsonrpc: JSONRPC_VERSION, id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}
