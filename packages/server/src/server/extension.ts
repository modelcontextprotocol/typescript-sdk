import type { JSONObject } from '@modelcontextprotocol/core-internal';

import type { Server } from './server';

/**
 * A server extension: a unit of protocol behaviour outside the core
 * specification (an MCP extension such as `io.modelcontextprotocol/tasks`,
 * or a vendor feature) that installs itself onto a {@linkcode Server}.
 *
 * Pass extensions at construction — `new McpServer(info, { extensions: [ext] })`
 * or `new Server(info, { extensions: [ext] })`. The server advertises each
 * extension under `capabilities.extensions[id]` and then calls `install`,
 * which is where the extension registers its custom methods
 * (`server.setRequestHandler(method, { params, result }, handler)`),
 * installs middleware on spec methods it needs to intercept
 * (`server.use('tools/call', …)`), and adds notification
 * handlers. The SDK provides the hooks; what an extension does behind them
 * — how it stores state, where its work runs — is the extension's own.
 */
export interface ServerExtension {
    /**
     * The extension identifier, prefix-qualified (`io.modelcontextprotocol/tasks`,
     * `com.example/feature-flags`). Advertised as the key under
     * `capabilities.extensions`.
     */
    readonly id: string;
    /**
     * The extension's settings object, advertised as the value under
     * `capabilities.extensions[id]`. `{}` (the default) means supported with
     * no settings.
     */
    readonly capability?: JSONObject;
    /** Installs the extension's handlers and middleware onto the server. Called once, at construction. */
    install(server: Server): void;
}
