import type {
    InferHandlerResult,
    JSONObject,
    RequestMethod,
    RequestMiddleware,
    ServerContext,
    StandardSchemaV1
} from '@modelcontextprotocol/core-internal';
import { requireExtension, setExtensionRequestHandler, uniqueExtensionIds } from '@modelcontextprotocol/core-internal';

import type { McpServer } from './mcp';

/**
 * A server extension: protocol behaviour outside the core specification,
 * such as the `io.modelcontextprotocol/tasks` extension or a vendor feature,
 * passed to the server at construction.
 *
 * ```ts
 * const server = new McpServer(info, { extensions: [tasks, skills] });
 * ```
 *
 * What is both required and declarative sits on the object: the `id`.
 * Everything else happens in `setup`, which runs once while the server is
 * constructed: optional declarations first (`ctx.capability`, `ctx.require`),
 * then custom request handlers, middleware on spec methods, and anything
 * registered on the `McpServer` itself, such as resources and tools.
 *
 * Experimental: the shape of an extension may change in a minor release.
 *
 * @experimental
 */
export interface ServerExtension {
    /**
     * The extension identifier, prefix-qualified (`io.modelcontextprotocol/tasks`,
     * `com.example/feature-flags`). Advertised as the key under
     * `capabilities.extensions`, and unique per server.
     */
    readonly id: string;
    /** Adds the extension to the server. Called once, at construction, in `extensions` order. */
    setup(ctx: ServerExtensionContext): void;
}

/**
 * What a {@linkcode ServerExtension}'s `setup` receives.
 *
 * Experimental: this shape may change in a minor release.
 *
 * @experimental
 */
export interface ServerExtensionContext {
    /** The server the extension is set up on: `registerTool`, `registerResource`, `ResourceTemplate`. */
    readonly mcp: McpServer;
    /**
     * Sets what the server advertises under `capabilities.extensions[id]`.
     * Without a call, the server advertises `{}`.
     */
    capability(settings: JSONObject): void;
    /**
     * Declares that this extension needs another extension, by id. Throws,
     * naming both, when the server doesn't install it, which fails the
     * constructor. The full list is known before any `setup` runs, so an
     * extension listed after this one counts. For behaviour that is merely
     * optional, check in code instead and carry on without it.
     */
    require(extensionId: `${string}/${string}`): void;
    /**
     * Middleware around whatever handler serves `method`, including a core
     * method or another extension's: it may answer, transform or refuse. Runs
     * outside middleware the application adds later with `mcp.server.use`, and
     * inside middleware from extensions earlier in `extensions`. See
     * `Protocol.use` for how middleware composes.
     */
    use(method: RequestMethod | (string & {}), middleware: RequestMiddleware<ServerContext>): void;
    /**
     * Registers the handler for a custom request method, like
     * `Server.setRequestHandler` with schemas, but checked: throws when `name`
     * is a core method (wrap those with `use` instead) or when a handler
     * already serves it, such as another extension's.
     */
    setRequestHandler<P extends StandardSchemaV1, R extends StandardSchemaV1 | undefined = undefined>(
        name: string,
        schemas: { params: P; result?: R },
        handler: (params: StandardSchemaV1.InferOutput<P>, ctx: ServerContext) => InferHandlerResult<R> | Promise<InferHandlerResult<R>>
    ): void;
}

/**
 * Sets up `extensions` on `mcp`, in order. Ids are checked before anything is
 * set up, so a duplicate leaves the server untouched. A `setup` that throws,
 * including an unmet `ctx.require`, fails the `McpServer` constructor that
 * called this, so a server with a partly set up extension never exists.
 *
 * Package-internal: called by the `McpServer` constructor.
 */
export function installServerExtensions(mcp: McpServer, extensions: readonly ServerExtension[]): void {
    const ids = uniqueExtensionIds(extensions);
    for (const extension of extensions) {
        if (typeof extension.setup !== 'function') {
            throw new TypeError(`Extension "${String((extension as { id: unknown }).id)}" has no setup`);
        }
    }

    for (const extension of extensions) {
        mcp.server.registerCapabilities({ extensions: { [extension.id]: {} } });
        extension.setup(contextFor(mcp, extension.id, ids));
    }
}

/** The context one extension's `setup` receives; everything it registers is attributed to `id`. */
function contextFor(mcp: McpServer, id: string, installed: ReadonlySet<string>): ServerExtensionContext {
    const server = mcp.server;
    return {
        mcp,
        capability(settings) {
            server.registerCapabilities({ extensions: { [id]: settings } });
        },
        require(extensionId) {
            requireExtension('server', installed, id, extensionId);
        },
        use(method, middleware) {
            server.use(method, middleware);
        },
        setRequestHandler(name, schemas, handler) {
            setExtensionRequestHandler(server, id, name, schemas, handler);
        }
    };
}
