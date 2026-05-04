import type { Express } from 'express';
import express from 'express';

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
           * For IPv6, provide addresses with brackets (e.g., `'[::1]'`).
           *
           * This is useful when binding to `'0.0.0.0'` or `'::'` but still wanting
           * to restrict which hostnames are allowed.
           */
          allowedHosts?: string[];
      };

/**
 * Options for creating an MCP Express application.
 */
export type CreateMcpExpressAppOptions = {
    /**
     * The hostname to bind to. Defaults to `'127.0.0.1'`.
     * When set to `'127.0.0.1'`, `'localhost'`, or `'::1'`, DNS rebinding protection is automatically enabled.
     */
    host?: string;

    /**
     * Controls the maximum request body size for the JSON body parser.
     * Passed directly to Express's `express.json({ limit })` option.
     * Defaults to Express's built-in default of `'100kb'`.
     *
     * @example '1mb', '500kb', '10mb'
     */
    jsonLimit?: string;
} & HostHeaderValidationOptions;

/**
 * Creates an Express application pre-configured for MCP servers.
 *
 * When the host is `'127.0.0.1'`, `'localhost'`, or `'::1'` (the default is `'127.0.0.1'`),
 * DNS rebinding protection middleware is automatically applied to protect against
 * DNS rebinding attacks on localhost servers.
 *
 * @param options - Configuration options
 * @returns A configured Express application
 *
 * @example Basic usage - defaults to 127.0.0.1 with DNS rebinding protection
 * ```ts source="./express.examples.ts#createMcpExpressApp_default"
 * const app = createMcpExpressApp();
 * ```
 *
 * @example Custom host - DNS rebinding protection only applied for localhost hosts
 * ```ts source="./express.examples.ts#createMcpExpressApp_customHost"
 * const appOpen = createMcpExpressApp({ host: '0.0.0.0' }); // No automatic DNS rebinding protection
 * const appLocal = createMcpExpressApp({ host: 'localhost' }); // DNS rebinding protection enabled
 * ```
 *
 * @example Custom allowed hosts for non-localhost binding
 * ```ts source="./express.examples.ts#createMcpExpressApp_allowedHosts"
 * const app = createMcpExpressApp({ host: '0.0.0.0', allowedHosts: ['myapp.local', 'localhost'] });
 * ```
 */
export function createMcpExpressApp(options: CreateMcpExpressAppOptions = {}): Express {
    const { host = '127.0.0.1', allowedHosts, jsonLimit, skipHostHeaderValidation } = options;

    const app = express();
    app.use(express.json(jsonLimit ? { limit: jsonLimit } : undefined));

    if (!skipHostHeaderValidation) {
        // If allowedHosts is explicitly provided, use that for validation
        if (allowedHosts) {
            app.use(hostHeaderValidation(allowedHosts));
        } else {
            // Apply DNS rebinding protection automatically for localhost hosts
            const localhostHosts = ['127.0.0.1', 'localhost', '::1'];
            if (localhostHosts.includes(host)) {
                app.use(localhostHostValidation());
            }
        }
    }

    return app;
}
