import type { JSONObject } from '@modelcontextprotocol/core-internal';

import type { Client } from './client';

/**
 * A client extension: the client half of protocol behaviour outside the
 * core specification (an MCP extension such as `io.modelcontextprotocol/tasks`,
 * or a vendor feature) that installs itself onto a {@linkcode Client}.
 *
 * Pass extensions at construction — `new Client(info, { extensions: [ext] })`.
 * The client advertises each extension under `capabilities.extensions[id]`
 * (in `initialize` on a legacy connection, in every request's
 * `_meta` client-capabilities envelope on a 2026-07-28 connection) and then
 * calls `install`, which is where the extension registers handlers for
 * server-to-client requests and notifications, or overrides the ones the
 * SDK installs (`client.overrideRequestHandler('elicitation/create', …)`).
 * The SDK provides the hooks; what an extension does behind them is its own.
 */
export interface ClientExtension {
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
    /** Installs the extension's handlers and overrides onto the client. Called once, at construction. */
    install(client: Client): void;
}
