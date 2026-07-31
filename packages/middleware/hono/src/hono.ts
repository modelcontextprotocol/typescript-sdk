import type { CreateMcpHandlerOptions, McpServerFactory } from '@modelcontextprotocol/server';
import { createMcpHandler, isJsonContentType } from '@modelcontextprotocol/server';
import type { Context, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';

import { hostHeaderValidation, localhostHostValidation } from './middleware/hostHeaderValidation';
import { localhostOriginValidation, originValidation } from './middleware/originValidation';

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

    /**
     * List of allowed origin hostnames for Origin header validation.
     * If provided, Origin validation will be applied using this list (port-agnostic,
     * hostnames only — the same convention as `allowedHosts`).
     *
     * When omitted, Origin validation is automatically enabled for localhost-class
     * binds (the same condition as host validation): requests without an `Origin`
     * header pass, while a present `Origin` whose hostname is not localhost-class
     * is rejected with `403`.
     */
    allowedOrigins?: string[];
}

/**
 * Creates a Hono application pre-configured for MCP servers.
 *
 * When the host is `'127.0.0.1'`, `'localhost'`, or `'::1'` (the default is `'127.0.0.1'`),
 * DNS rebinding protection middleware is automatically applied to protect against
 * DNS rebinding attacks on localhost servers.
 *
 * This also installs a small JSON body parsing middleware (similar to `express.json()`)
 * that stashes the parsed body into `c.set('parsedBody', ...)` when the `Content-Type`
 * media type is `application/json`.
 *
 * @param options - Configuration options
 * @returns A configured Hono application
 */
export function createMcpHonoApp(options: CreateMcpHonoAppOptions = {}): Hono {
    const { host = '127.0.0.1', allowedHosts, allowedOrigins } = options;

    const app = new Hono();

    // Similar to `express.json()`: parse JSON bodies and make them available to MCP adapters via `parsedBody`.
    app.use('*', async (c: Context, next) => {
        // If an upstream middleware already set parsedBody, keep it.
        if (c.get('parsedBody') !== undefined) {
            return await next();
        }

        // Parsed media type, never a substring match — see isJsonContentType.
        // A body left unparsed here is answered 415 by the transport's own
        // Content-Type check downstream.
        if (!isJsonContentType(c.req.header('content-type'))) {
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

    // Origin validation follows the same arming ladder as host validation:
    // an explicit allowlist wins; otherwise localhost-class binds are protected
    // by default. Requests without an Origin header always pass.
    if (allowedOrigins) {
        app.use('*', originValidation(allowedOrigins));
    } else if (['127.0.0.1', 'localhost', '::1'].includes(host)) {
        app.use('*', localhostOriginValidation());
    }

    return app;
}

/**
 * Options for the {@link mcp} middleware.
 *
 * Extends {@link CreateMcpHonoAppOptions} (host/origin protection) with the
 * options forwarded to {@link createMcpHandler}.
 */
export interface McpMiddlewareOptions extends CreateMcpHonoAppOptions {
    /**
     * Options forwarded to {@link createMcpHandler} — e.g. `legacy: 'reject'`
     * for a modern-only strict endpoint.
     */
    handler?: CreateMcpHandlerOptions;
}

/**
 * Serves MCP as a single Hono middleware — the one-call way to mount MCP on a
 * route you already own.
 *
 * It wires the same defaults as {@link createMcpHonoApp} (JSON body parsing and
 * localhost DNS-rebinding / origin protection) in front of a
 * {@link createMcpHandler}, so the endpoint serves the modern 2026-07-28
 * protocol and falls back to stateless 2025-era serving. A fresh server is
 * built from your factory for each request.
 *
 * @example
 * ```ts
 * const app = new Hono();
 * app.all('/mcp', mcp(() => new McpServer({ name: 'my-server', version: '1.0.0' })));
 * ```
 *
 * @param factory - Builds a fresh MCP server per request.
 * @param options - Host/origin protection and handler options.
 * @returns A Hono `MiddlewareHandler` that serves the MCP endpoint.
 */
export function mcp(factory: McpServerFactory, options?: McpMiddlewareOptions): MiddlewareHandler {
    const { handler: handlerOptions, ...appOptions } = options ?? {};
    const handler = createMcpHandler(factory, handlerOptions);
    const app = createMcpHonoApp(appOptions);
    app.all('*', (c: Context<{ Variables: { parsedBody: unknown } }>) => handler.fetch(c.req.raw, { parsedBody: c.get('parsedBody') }));
    // The inner app is self-contained (its body parser and Host/Origin guards
    // read only the request), so forwarding just the raw request is enough —
    // and it avoids `c.executionCtx`, which throws off Cloudflare Workers.
    return async c => app.fetch(c.req.raw);
}
