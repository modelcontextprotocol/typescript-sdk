import type {
    ClientCapabilities,
    ClientContext,
    InferHandlerResult,
    JSONObject,
    RequestMethod,
    RequestMiddleware,
    StandardSchemaV1
} from '@modelcontextprotocol/core-internal';
import {
    installExtensions,
    requireExtension,
    setExtensionRequestHandler,
    useAsExtension,
    writeExtensionCapability
} from '@modelcontextprotocol/core-internal';

import type { Client } from './client';

/**
 * A client extension: the client half of protocol behaviour outside the core
 * specification, such as the `io.modelcontextprotocol/tasks` extension or a
 * vendor feature, passed to the client at construction.
 *
 * ```ts
 * const client = new Client(info, { extensions: [tasks] });
 * ```
 *
 * What is both required and declarative sits on the object: the `id`.
 * Everything else happens in `setup`, which runs once while the client is
 * constructed: optional declarations first (`ctx.capability`, `ctx.require`),
 * then handlers for server-to-client requests, middleware, and the result
 * kinds it accepts.
 *
 * Experimental: the shape of an extension may change in a minor release.
 *
 * @experimental
 */
export interface ClientExtension {
    /**
     * The extension identifier, prefix-qualified (`io.modelcontextprotocol/tasks`,
     * `com.example/feature-flags`). Advertised as the key under the client's
     * `capabilities.extensions`, and unique per client.
     */
    readonly id: string;
    /**
     * Adds the extension to the client. Called once, at construction, in
     * `extensions` order. It may be async: the setups after it wait for it,
     * and `connect` waits for all of them and rejects if one fails.
     */
    setup(ctx: ClientExtensionContext): void | Promise<void>;
}

/**
 * What a {@linkcode ClientExtension}'s `setup` receives.
 *
 * Experimental: this shape may change in a minor release.
 *
 * @experimental
 */
export interface ClientExtensionContext {
    /** The client the extension is set up on. */
    readonly client: Client;
    /**
     * Sets what the client advertises under `capabilities.extensions[id]`:
     * in `initialize` on a legacy connection, and in every request's
     * client-capabilities envelope on a 2026-07-28 connection. Without a call,
     * the client advertises `{}`. The entry belongs to the extension: setting
     * it anywhere else throws.
     */
    capability(settings: JSONObject): void;
    /**
     * Declares that this extension needs another extension, by id. Throws,
     * naming both, when the client doesn't install it, which fails the
     * constructor. The full list is known before any `setup` runs, so an
     * extension listed after this one counts. For behaviour that is merely
     * optional, check in code instead and carry on without it.
     */
    require(extensionId: `${string}/${string}`): void;
    /**
     * Middleware around whatever handler serves a server-to-client request
     * `method`. Runs outside middleware the application adds with
     * `client.use`, and inside middleware from extensions earlier in
     * `extensions`. See `Protocol.use`.
     */
    use(method: RequestMethod | (string & {}), middleware: RequestMiddleware<ClientContext>): void;
    /**
     * Registers the handler for a custom server-to-client request, like
     * `Client.setRequestHandler` with schemas, but checked: throws when `name`
     * is a core method (wrap those with `use` instead) or when a handler
     * already serves it, such as another extension's. Served on 2025-11-25
     * connections only: 2026-07-28 has no server-to-client request channel.
     */
    setRequestHandler<P extends StandardSchemaV1, R extends StandardSchemaV1 | undefined = undefined>(
        name: string,
        schemas: { params: P; result?: R },
        handler: (params: StandardSchemaV1.InferOutput<P>, ctx: ClientContext) => InferHandlerResult<R> | Promise<InferHandlerResult<R>>
    ): void;
    /**
     * Lets results of `method` carry a `resultType` this extension defines,
     * such as the Tasks extension's `"task"` on `tools/call`. See
     * `Protocol.acceptResultType`.
     */
    acceptResultType(method: string, resultType: string): void;
}

/** Package-internal: sets `extensions` up for the constructor (see `installExtensions`). */
export function installClientExtensions(
    client: Client,
    extensions: readonly ClientExtension[],
    capabilities: ClientCapabilities | undefined
): void {
    installExtensions(
        client,
        extensions,
        capabilities,
        capabilities => client.registerCapabilities(capabilities),
        (id, installed) => contextFor(client, id, installed)
    );
}

/** The context one extension's `setup` receives; everything it registers is attributed to `id`. */
function contextFor(client: Client, id: string, installed: ReadonlySet<string>): ClientExtensionContext {
    return {
        client,
        capability(settings) {
            writeExtensionCapability(client, id, settings, capabilities => client.registerCapabilities(capabilities));
        },
        require(extensionId) {
            requireExtension('client', installed, id, extensionId);
        },
        use(method, middleware) {
            useAsExtension(client, method, middleware);
        },
        setRequestHandler(name, schemas, handler) {
            setExtensionRequestHandler(client, id, name, schemas, handler);
        },
        acceptResultType(method, resultType) {
            client.acceptResultType(method, resultType);
        }
    };
}
