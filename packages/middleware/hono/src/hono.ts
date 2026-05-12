import type { AuthInfo, Dispatchable, HandleHttpOptions } from '@modelcontextprotocol/server';
import { handleHttp } from '@modelcontextprotocol/server';
import type { Context, Handler } from 'hono';
import { Hono } from 'hono';

import { hostHeaderValidation, localhostHostValidation } from './middleware/hostHeaderValidation.js';

/**
 * Hono context variables {@linkcode mcpHonoHandler} reads. Upstream middleware
 * may set `parsedBody` ({@linkcode createMcpHonoApp} does this for JSON requests)
 * and `authInfo` (e.g. a bearer-token verifier) before this handler runs.
 */
export type McpHonoVariables = { parsedBody?: unknown; authInfo?: AuthInfo };

/**
 * Mounts an `McpServer` (or any `Protocol` subclass) as a Hono `Handler`.
 * Each request flows through `mcp.dispatch()` directly via {@linkcode handleHttp};
 * `mcp.connect()` and a transport instance are not used.
 *
 * Reads `c.get('parsedBody')` (set by {@linkcode createMcpHonoApp}'s JSON middleware)
 * and `c.get('authInfo')` (set by an upstream auth middleware) when present.
 *
 * ```ts
 * import { McpServer, SessionCompat } from '@modelcontextprotocol/server';
 * import { createMcpHonoApp, mcpHonoHandler } from '@modelcontextprotocol/hono';
 *
 * const mcp = new McpServer({ name: 's', version: '1.0.0' });
 * const app = createMcpHonoApp();
 * app.all('/mcp', mcpHonoHandler(mcp, { session: new SessionCompat() }));
 * ```
 */
export function mcpHonoHandler(mcp: Dispatchable, options?: HandleHttpOptions): Handler<{ Variables: McpHonoVariables }> {
    const handler = handleHttp(mcp, options);
    return c => {
        const parsedBody = c.get('parsedBody');
        const authInfo = c.get('authInfo');
        const extra = authInfo !== undefined || parsedBody !== undefined ? { authInfo, parsedBody } : undefined;
        return handler(c.req.raw, extra);
    };
}

/**
 * Options for creating an MCP Hono application.
 */
export interface CreateMcpHonoAppOptions {
    /**
     * The hostname to bind to. Defaults to `'127.0.0.1'`.
     * When set to `'127.0.0.1'`, `'localhost'`, or `'::1'`, DNS rebinding protection is automatically enabled.
     */
    host?: string;

    /**
     * List of allowed hostnames for DNS rebinding protection.
     * If provided, host header validation will be applied using this list.
     * For IPv6, provide addresses with brackets (e.g., '[::1]').
     *
     * This is useful when binding to '0.0.0.0' or '::' but still wanting
     * to restrict which hostnames are allowed.
     */
    allowedHosts?: string[];
}

/**
 * Creates a Hono application pre-configured for MCP servers.
 *
 * When the host is `'127.0.0.1'`, `'localhost'`, or `'::1'` (the default is `'127.0.0.1'`),
 * DNS rebinding protection middleware is automatically applied to protect against
 * DNS rebinding attacks on localhost servers.
 *
 * This also installs a small JSON body parsing middleware (similar to `express.json()`)
 * that stashes the parsed body into `c.set('parsedBody', ...)` when `Content-Type` includes
 * `application/json`.
 *
 * @param options - Configuration options
 * @returns A configured Hono application
 */
export function createMcpHonoApp(options: CreateMcpHonoAppOptions = {}): Hono {
    const { host = '127.0.0.1', allowedHosts } = options;

    const app = new Hono();

    // Similar to `express.json()`: parse JSON bodies and make them available to MCP adapters via `parsedBody`.
    app.use('*', async (c: Context, next) => {
        // If an upstream middleware already set parsedBody, keep it.
        if (c.get('parsedBody') !== undefined) {
            return await next();
        }

        const ct = c.req.header('content-type') ?? '';
        if (!ct.includes('application/json')) {
            return await next();
        }

        try {
            // Parse from a clone so we don't consume the original request stream.
            const parsed = await c.req.raw.clone().json();
            c.set('parsedBody', parsed);
        } catch {
            // Mirror express.json() behavior loosely: reject invalid JSON.
            return c.text('Invalid JSON', 400);
        }

        return await next();
    });

    // If allowedHosts is explicitly provided, use that for validation.
    if (allowedHosts) {
        app.use('*', hostHeaderValidation(allowedHosts));
    } else {
        // Apply DNS rebinding protection automatically for localhost hosts.
        const localhostHosts = ['127.0.0.1', 'localhost', '::1'];
        if (localhostHosts.includes(host)) {
            app.use('*', localhostHostValidation());
        } else if (host === '0.0.0.0' || host === '::') {
            // Warn when binding to all interfaces without DNS rebinding protection.
            // eslint-disable-next-line no-console
            console.warn(
                `Warning: Server is binding to ${host} without DNS rebinding protection. ` +
                    'Consider using the allowedHosts option to restrict allowed hosts, ' +
                    'or use authentication to protect your server.'
            );
        }
    }

    return app;
}
