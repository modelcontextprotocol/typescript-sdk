import { DEFAULT_MAX_REQUEST_BODY_SIZE, isJsonContentType, readRequestBody } from '@modelcontextprotocol/server';
import type { Context } from 'hono';
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

    /**
     * Upper bound, in bytes, on a JSON request body the app's body-parsing
     * middleware reads. A larger body is answered `413` before being parsed.
     * Must be a positive number. The counterpart of `createMcpExpressApp`'s
     * `jsonLimit`.
     * @default 4194304 (4 MiB)
     */
    maxRequestBodySize?: number;
}

/**
 * Reads (bounded, via the transport's own reader) and parses a JSON body from a
 * clone of the request, so the original stream stays readable. Returning only the
 * parsed value keeps the decoded text from outliving the parse.
 */
async function parseJsonBody(request: Request, maxBytes: number): Promise<{ tooLarge: true } | { tooLarge: false; value: unknown }> {
    const body = await readRequestBody(request, maxBytes);
    if (body.tooLarge) {
        return { tooLarge: true };
    }
    return { tooLarge: false, value: JSON.parse(body.text) };
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
 * media type is `application/json`. It runs after the Host/Origin validation, and JSON
 * bodies over `maxRequestBodySize` (4 MiB by default) are answered `413` before being parsed.
 *
 * @param options - Configuration options
 * @returns A configured Hono application
 */
export function createMcpHonoApp(options: CreateMcpHonoAppOptions = {}): Hono {
    const { host = '127.0.0.1', allowedHosts, allowedOrigins } = options;
    const maxRequestBodySize = options.maxRequestBodySize ?? DEFAULT_MAX_REQUEST_BODY_SIZE;
    if (typeof maxRequestBodySize !== 'number' || !Number.isFinite(maxRequestBodySize) || maxRequestBodySize <= 0) {
        throw new RangeError(`maxRequestBodySize must be a positive number of bytes, got ${String(maxRequestBodySize)}`);
    }

    const app = new Hono();

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

    // Similar to `express.json()`: parse JSON bodies (up to maxRequestBodySize; larger ones are
    // answered 413) and make them available to MCP adapters via `parsedBody`.
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
            const parsed = await parseJsonBody(c.req.raw.clone(), maxRequestBodySize);
            if (parsed.tooLarge) {
                return c.json(
                    {
                        jsonrpc: '2.0',
                        error: { code: -32_000, message: `Payload Too Large: Request body must not exceed ${maxRequestBodySize} bytes` },
                        id: null
                    },
                    413
                );
            }
            c.set('parsedBody', parsed.value);
        } catch {
            // Mirror express.json() behavior loosely: reject invalid JSON.
            return c.text('Invalid JSON', 400);
        }

        return await next();
    });

    return app;
}
