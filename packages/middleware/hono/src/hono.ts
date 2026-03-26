import type { Context } from 'hono';
import { Hono } from 'hono';

import { hostHeaderValidation, localhostHostValidation } from './middleware/hostHeaderValidation.js';

/**
 * Host header validation options for DNS rebinding protection.
 *
 * Either skip validation entirely, or optionally provide an explicit allowlist.
 */
export type HostHeaderValidationOptions =
    | {
          /**
           * When set to `true`, disables all automatic host header validation
           * (DNS rebinding protection).
           *
           * Use this when the server sits behind a reverse proxy or load balancer
           * that rewrites the `Host` header, or when running in an isolated network
           * (e.g., containers) where DNS rebinding is not a concern.
           */
          skipHostHeaderValidation: true;
          allowedHosts?: never;
      }
    | {
          skipHostHeaderValidation?: false;
          /**
           * List of allowed hostnames for DNS rebinding protection.
           * If provided, host header validation will be applied using this list.
           * For IPv6, provide addresses with brackets (e.g., '[::1]').
           *
           * This is useful when binding to '0.0.0.0' or '::' but still wanting
           * to restrict which hostnames are allowed.
           */
          allowedHosts?: string[];
      };

/**
 * Options for creating an MCP Hono application.
 */
export type CreateMcpHonoAppOptions = {
    /**
     * The hostname to bind to. Defaults to `'127.0.0.1'`.
     * When set to `'127.0.0.1'`, `'localhost'`, or `'::1'`, DNS rebinding protection is automatically enabled.
     */
    host?: string;
} & HostHeaderValidationOptions;

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
    const { host = '127.0.0.1', allowedHosts, skipHostHeaderValidation } = options;

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

    if (!skipHostHeaderValidation) {
        // If allowedHosts is explicitly provided, use that for validation.
        if (allowedHosts) {
            app.use('*', hostHeaderValidation(allowedHosts));
        } else {
            // Apply DNS rebinding protection automatically for localhost hosts.
            const localhostHosts = ['127.0.0.1', 'localhost', '::1'];
            if (localhostHosts.includes(host)) {
                app.use('*', localhostHostValidation());
            }
        }
    }

    return app;
}
