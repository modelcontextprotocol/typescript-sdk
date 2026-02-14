import type { Context } from 'hono';
import { Hono } from 'hono';

import { hostHeaderValidation, localhostHostValidation } from './middleware/hostHeaderValidation.js';

const DEFAULT_MAX_BODY_BYTES = 1_000_000; // 1MB

async function readRequestTextWithLimit(req: Request, maxBytes: number): Promise<string> {
    const body = req.body;
    if (!body) return '';

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!value) continue;

        total += value.byteLength;
        if (total > maxBytes) {
            void reader.cancel().catch(() => {});
            throw new Error('payload_too_large');
        }
        chunks.push(value);
    }

    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
        out.set(c, offset);
        offset += c.byteLength;
    }

    return new TextDecoder().decode(out);
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

    /**
     * Maximum JSON request body size in bytes.
     * Used by the built-in JSON parsing middleware for basic DoS resistance.
     *
     * @default 1_000_000 (1 MB)
     */
    maxBodyBytes?: number;
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
    const { host = '127.0.0.1', allowedHosts, maxBodyBytes = DEFAULT_MAX_BODY_BYTES } = options;

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

        // Fast-path: reject known oversized payloads without reading.
        const clRaw = c.req.header('content-length') ?? '';
        const cl = Number(clRaw);
        if (Number.isFinite(cl) && cl > maxBodyBytes) {
            return c.text('Payload too large', 413);
        }

        // Parse from a clone so we don't consume the original request stream.
        let text: string;
        try {
            text = await readRequestTextWithLimit(c.req.raw.clone(), maxBodyBytes);
        } catch (error) {
            if (error instanceof Error && error.message === 'payload_too_large') {
                return c.text('Payload too large', 413);
            }
            return c.text('Invalid JSON', 400);
        }

        try {
            const parsed = JSON.parse(text);
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
