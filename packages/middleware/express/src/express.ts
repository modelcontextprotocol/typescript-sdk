import type { ErrorRequestHandler, Express } from 'express';
import express from 'express';

import { hostHeaderValidation, localhostHostValidation } from './middleware/hostHeaderValidation.js';

const DEFAULT_MAX_BODY_BYTES = 100 * 1024; // Express default (100kb), made explicit.

// Ensure body parsing failures return JSON-RPC-shaped errors (instead of HTML).
const jsonBodyErrorHandler: ErrorRequestHandler = (error, _req, res, next) => {
    if (res.headersSent) return next(error);

    const type = typeof (error as { type?: unknown } | null)?.type === 'string' ? String((error as { type: string }).type) : '';
    if (type === 'entity.too.large') {
        res.status(413).json({
            jsonrpc: '2.0',
            error: { code: -32_000, message: 'Payload too large' },
            id: null
        });
        return;
    }
    if (type === 'entity.parse.failed') {
        res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32_700, message: 'Parse error: Invalid JSON' },
            id: null
        });
        return;
    }

    next(error);
};

/**
 * Options for creating an MCP Express application.
 */
export interface CreateMcpExpressAppOptions {
    /**
     * The hostname to bind to. Defaults to '127.0.0.1'.
     * When set to '127.0.0.1', 'localhost', or '::1', DNS rebinding protection is automatically enabled.
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
     * Maximum size (in bytes) for JSON request bodies.
     *
     * Defaults to 100kb (Express default). Increase this if your tool calls need larger payloads.
     */
    maxBodyBytes?: number;
}

/**
 * Creates an Express application pre-configured for MCP servers.
 *
 * When the host is '127.0.0.1', 'localhost', or '::1' (the default is '127.0.0.1'),
 * DNS rebinding protection middleware is automatically applied to protect against
 * DNS rebinding attacks on localhost servers.
 *
 * @param options - Configuration options
 * @returns A configured Express application
 *
 * @example
 * ```typescript
 * // Basic usage - defaults to 127.0.0.1 with DNS rebinding protection
 * const app = createMcpExpressApp();
 *
 * // Custom host - DNS rebinding protection only applied for localhost hosts
 * const app = createMcpExpressApp({ host: '0.0.0.0' }); // No automatic DNS rebinding protection
 * const app = createMcpExpressApp({ host: 'localhost' }); // DNS rebinding protection enabled
 *
 * // Custom allowed hosts for non-localhost binding
 * const app = createMcpExpressApp({ host: '0.0.0.0', allowedHosts: ['myapp.local', 'localhost'] });
 * ```
 */
export function createMcpExpressApp(options: CreateMcpExpressAppOptions = {}): Express {
    const { host = '127.0.0.1', allowedHosts, maxBodyBytes = DEFAULT_MAX_BODY_BYTES } = options;

    const app = express();

    // If allowedHosts is explicitly provided, use that for validation
    if (allowedHosts) {
        app.use(hostHeaderValidation(allowedHosts));
    } else {
        // Apply DNS rebinding protection automatically for localhost hosts
        const localhostHosts = ['127.0.0.1', 'localhost', '::1'];
        if (localhostHosts.includes(host)) {
            app.use(localhostHostValidation());
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

    // Parse JSON request bodies for MCP endpoints (explicit limit to reduce DoS risk).
    app.use(express.json({ limit: maxBodyBytes }));

    app.use(jsonBodyErrorHandler);

    return app;
}
