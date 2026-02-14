import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';

import { hostHeaderValidation, localhostHostValidation } from './middleware/hostHeaderValidation.js';

/**
 * Options for creating an MCP Fastify application.
 */
export interface CreateMcpFastifyAppOptions {
    /**
     * The hostname to bind to. Defaults to `'127.0.0.1'`.
     * When set to `'127.0.0.1'`, `'localhost'`, or `'::1'`, DNS rebinding protection is automatically enabled.
     */
    host?: string;

    /**
     * List of allowed hostnames for DNS rebinding protection.
     * If provided, host header validation will be applied using this list.
     * For IPv6, provide addresses with brackets (e.g., `'[::1]'`).
     *
     * This is useful when binding to `'0.0.0.0'` or `'::'` but still wanting
     * to restrict which hostnames are allowed.
     */
    allowedHosts?: string[];
}

/**
 * Creates a Fastify application pre-configured for MCP servers.
 *
 * When the host is `'127.0.0.1'`, `'localhost'`, or `'::1'` (the default is `'127.0.0.1'`),
 * DNS rebinding protection is automatically applied via an onRequest hook to protect against
 * DNS rebinding attacks on localhost servers.
 *
 * Fastify parses JSON request bodies by default, so no additional middleware is required
 * for MCP Streamable HTTP endpoints.
 *
 * @param options - Configuration options
 * @returns A configured Fastify application
 *
 * @example Basic usage - defaults to 127.0.0.1 with DNS rebinding protection
 * ```ts source="./fastify.examples.ts#createMcpFastifyApp_default"
 * const app = createMcpFastifyApp();
 * ```
 *
 * @example Custom host - DNS rebinding protection only applied for localhost hosts
 * ```ts source="./fastify.examples.ts#createMcpFastifyApp_customHost"
 * const appOpen = createMcpFastifyApp({ host: '0.0.0.0' }); // No automatic DNS rebinding protection
 * const appLocal = createMcpFastifyApp({ host: 'localhost' }); // DNS rebinding protection enabled
 * ```
 *
 * @example Custom allowed hosts for non-localhost binding
 * ```ts source="./fastify.examples.ts#createMcpFastifyApp_allowedHosts"
 * const app = createMcpFastifyApp({ host: '0.0.0.0', allowedHosts: ['myapp.local', 'localhost'] });
 * ```
 */
export function createMcpFastifyApp(options: CreateMcpFastifyAppOptions = {}): FastifyInstance {
    const { host = '127.0.0.1', allowedHosts } = options;

    const app = Fastify();

    // Fastify parses JSON by default - no middleware needed

    // If allowedHosts is explicitly provided, use that for validation
    if (allowedHosts) {
        app.addHook('onRequest', hostHeaderValidation(allowedHosts));
    } else {
        // Apply DNS rebinding protection automatically for localhost hosts
        const localhostHosts = ['127.0.0.1', 'localhost', '::1'];
        if (localhostHosts.includes(host)) {
            app.addHook('onRequest', localhostHostValidation());
        } else if (host === '0.0.0.0' || host === '::') {
            // Warn when binding to all interfaces without DNS rebinding protection
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
