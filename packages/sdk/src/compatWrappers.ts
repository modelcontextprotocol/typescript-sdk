// v1 compat: subclass wrappers that restore the v1 schema-first-arg
// `setRequestHandler(ZodRequestSchema, handler)` form. v2's `Protocol.setRequestHandler`
// is method-string-keyed; these shims extract the method literal from the schema and forward.
//
// Only the meta-package provides this overload, by design — the underlying
// `@modelcontextprotocol/{server,client}` packages stay on the v2 API.

import {
    Client as BaseClient,
    type ClientContext,
    type NotificationMethod,
    type RequestMethod,
    type Result,
    type StandardSchemaV1
} from '@modelcontextprotocol/client';
import {
    McpServer as BaseMcpServer,
    type RequestHandlerSchemas,
    type ResultTypeMap,
    Server as BaseServer,
    type ServerContext,
    type ServerOptions
} from '@modelcontextprotocol/server';
import type * as z from 'zod';

type ZodRequestSchema<M extends string = string> = z.ZodObject<{ method: z.ZodLiteral<M> } & z.ZodRawShape>;
type ZodNotificationSchema<M extends string = string> = ZodRequestSchema<M>;

function methodFromZodSchema(schema: ZodRequestSchema): string {
    const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
    const methodField = shape?.method as z.ZodLiteral<string> | undefined;
    const method = methodField && 'value' in methodField ? methodField.value : undefined;
    if (typeof method !== 'string') {
        throw new TypeError(
            'setRequestHandler: first argument must be a method string, a {params, result?} schema bundle, or a v1-style Zod request schema with a `.shape.method` literal.'
        );
    }
    return method;
}

function isZodRequestSchema(arg: unknown): arg is ZodRequestSchema {
    return typeof arg === 'object' && arg !== null && 'shape' in arg && typeof (arg as { shape: unknown }).shape === 'object';
}

type LegacyRequestHandler<S extends ZodRequestSchema, Ctx> = (request: z.infer<S>, ctx: Ctx) => Result | Promise<Result>;
type LegacyNotificationHandler<S extends ZodNotificationSchema> = (notification: z.infer<S>) => void | Promise<void>;

/**
 * Adds the v1 schema-first-arg overloads to `setRequestHandler` / `setNotificationHandler`.
 * Returned class is a drop-in replacement for the base; instances satisfy `instanceof Base`.
 */
function withV1SchemaOverloads<
    Ctx,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    TBase extends abstract new (...args: any[]) => {
        setRequestHandler(method: string, ...rest: unknown[]): void;
        setNotificationHandler(method: string, ...rest: unknown[]): void;
    }
>(Base: TBase) {
    abstract class WithV1 extends Base {
        /** v1 compat: accepts a Zod request schema with a `method` literal as the first arg. */
        override setRequestHandler<S extends ZodRequestSchema>(schema: S, handler: LegacyRequestHandler<S, Ctx>): void;
        override setRequestHandler<M extends RequestMethod>(
            method: M,
            handler: (request: { method: M; params?: Record<string, unknown> }, ctx: Ctx) => ResultTypeMap[M] | Promise<ResultTypeMap[M]>
        ): void;
        override setRequestHandler<P extends StandardSchemaV1, R extends StandardSchemaV1 | undefined = undefined>(
            method: string,
            schemas: RequestHandlerSchemas<P, R>,
            handler: (
                params: StandardSchemaV1.InferOutput<P>,
                ctx: Ctx
            ) => R extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<R> | Promise<StandardSchemaV1.InferOutput<R>> : Result | Promise<Result>
        ): void;
        override setRequestHandler(arg1: string | ZodRequestSchema, arg2: unknown, arg3?: unknown): void {
            if (typeof arg1 === 'string') {
                return arg3 === undefined ? super.setRequestHandler(arg1, arg2) : super.setRequestHandler(arg1, arg2, arg3);
            }
            const method = methodFromZodSchema(arg1);
            return super.setRequestHandler(method, arg2);
        }

        /** v1 compat: accepts a Zod notification schema with a `method` literal as the first arg. */
        override setNotificationHandler<S extends ZodNotificationSchema>(schema: S, handler: LegacyNotificationHandler<S>): void;
        override setNotificationHandler<M extends NotificationMethod>(method: M, handler: (notification: unknown) => void | Promise<void>): void;
        override setNotificationHandler<P extends StandardSchemaV1>(
            method: string,
            schemas: { params: P },
            handler: (params: StandardSchemaV1.InferOutput<P>, notification: unknown) => void | Promise<void>
        ): void;
        override setNotificationHandler(arg1: string | ZodNotificationSchema, arg2: unknown, arg3?: unknown): void {
            if (typeof arg1 === 'string') {
                return arg3 === undefined ? super.setNotificationHandler(arg1, arg2) : super.setNotificationHandler(arg1, arg2, arg3);
            }
            const method = methodFromZodSchema(arg1);
            return super.setNotificationHandler(method, arg2);
        }
    }
    return WithV1;
}

/** v1-compat `Server`: adds the schema-first-arg `setRequestHandler` overload. */
export class Server extends withV1SchemaOverloads<ServerContext, typeof BaseServer>(BaseServer) {}

/** v1-compat `Client`: adds the schema-first-arg `setRequestHandler` overload. */
export class Client extends withV1SchemaOverloads<ClientContext, typeof BaseClient>(BaseClient) {}

/**
 * v1-compat `McpServer`: `.server` is the compat-wrapped {@link Server} so
 * `mcp.server.setRequestHandler(ZodSchema, h)` works.
 */
export class McpServer extends BaseMcpServer {
    declare readonly server: Server;
    constructor(serverInfo: ConstructorParameters<typeof BaseMcpServer>[0], options?: ServerOptions) {
        super(serverInfo, options);
        // Base constructor's only side effect is `this.server = new Server(...)`; replace
        // with the compat-wrapped subclass so `mcp.server.setRequestHandler(ZodSchema, h)` works.
        (this as { server: Server }).server = new Server(serverInfo, options);
    }
}

export { isZodRequestSchema as _isZodRequestSchema };
