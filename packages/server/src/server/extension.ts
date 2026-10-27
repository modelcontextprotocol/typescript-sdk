import type {
    InferHandlerResult,
    JSONObject,
    RequestMethod,
    RequestMiddleware,
    ServerContext,
    StandardSchemaV1
} from '@modelcontextprotocol/core-internal';
import {
    installExtensions,
    requireExtension,
    setExtensionRequestHandler,
    useAsExtension,
    writeExtensionCapability
} from '@modelcontextprotocol/core-internal';

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
    /**
     * Adds the extension to the server. Called once, at construction, in
     * `extensions` order. It may be async: the setups after it wait for it,
     * and `connect` waits for all of them and rejects if one fails.
     */
    setup(ctx: ServerExtensionContext): void | Promise<void>;
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
     * Without a call, the server advertises `{}`. The entry belongs to the
     * extension: setting it anywhere else throws.
     */
    capability(settings: JSONObject): void;
    /**
     * Declares that this extension needs another extension, by id. Throws,
     * naming both, when the server doesn't install it, which fails the
     * constructor, or `connect` from or after an async `setup`. The full list is known before any `setup` runs, so an
     * extension listed after this one counts. For behaviour that is merely
     * optional, check in code instead and carry on without it.
     */
    require(extensionId: `${string}/${string}`): void;
    /**
     * Middleware around whatever handler serves `method`, including a core
     * method or another extension's: it may answer, transform or refuse. Runs
     * outside middleware the application adds with `mcp.server.use`, and
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

/** Package-internal: sets `extensions` up for the constructor (see `installExtensions`). */
export function installServerExtensions(mcp: McpServer, extensions: readonly ServerExtension[]): void {
    const server = mcp.server;
    installExtensions(
        server,
        extensions,
        server.getCapabilities(),
        capabilities => server.registerCapabilities(capabilities),
        (id, installed) => contextFor(mcp, id, installed)
    );
}

/** The context one extension's `setup` receives; everything it registers is attributed to `id`. */
function contextFor(mcp: McpServer, id: string, installed: ReadonlySet<string>): ServerExtensionContext {
    const server = mcp.server;
    return {
        mcp,
        capability(settings) {
            writeExtensionCapability(server, id, settings, capabilities => server.registerCapabilities(capabilities));
        },
        require(extensionId) {
            requireExtension('server', installed, id, extensionId);
        },
        use(method, middleware) {
            useAsExtension(server, method, middleware);
        },
        setRequestHandler(name, schemas, handler) {
            setExtensionRequestHandler(server, id, name, schemas, handler);
        }
    };
}

/**
 * Sets one extension up on a server that is already constructed, for the
 * deprecated `SkillsExtension.attach`. The capability entry is written only
 * once `setup` has returned, so a failed setup leaves none. Middleware goes in
 * the application tier.
 *
 * Package-internal.
 */
export function attachServerExtension(mcp: McpServer, extension: ServerExtension): void {
    const server = mcp.server;
    const installed = new Set([...Object.keys(server.getCapabilities().extensions ?? {}), extension.id]);
    let settings: JSONObject = {};
    const result = extension.setup({
        mcp,
        capability(next) {
            settings = next;
        },
        require(extensionId) {
            requireExtension('server', installed, extension.id, extensionId);
        },
        use(method, middleware) {
            server.use(method, middleware);
        },
        setRequestHandler(name, schemas, handler) {
            setExtensionRequestHandler(server, extension.id, name, schemas, handler);
        }
    });
    if (result !== undefined) throw new TypeError(`Extension "${extension.id}" has an async setup; pass it in extensions instead`);
    server.registerCapabilities({ extensions: { [extension.id]: settings } });
}
