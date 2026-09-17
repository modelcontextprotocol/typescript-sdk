import type { IncomingMessage, ServerResponse } from 'node:http';

import { localhostAllowedOrigins, validateOriginHeader } from '@modelcontextprotocol/server';

/**
 * Node.js request guard for Origin header validation.
 * Validates the `Origin` header hostname (port-agnostic) against an allowed list.
 *
 * Requests without an `Origin` header pass (non-browser MCP clients do not send
 * one); a present value that is not allowed, or that cannot be parsed, is
 * rejected with `403`. The guard returns whether the request may proceed: when
 * it returns `false` it has already answered the request and the caller must
 * not handle it further.
 *
 * @param allowedOriginHostnames - List of allowed origin hostnames (without scheme or port).
 *   For IPv6, provide the address with brackets (e.g., `[::1]`).
 *
 * @example
 * ```ts
 * const validateOrigin = originValidation(['localhost', '127.0.0.1', '[::1]']);
 * http.createServer((req, res) => {
 *     if (!validateOrigin(req, res)) return;
 *     void transport.handleRequest(req, res);
 * });
 * ```
 */
export function originValidation(allowedOriginHostnames: string[]): (req: IncomingMessage, res: ServerResponse) => boolean {
    return (req, res) => {
        const result = validateOriginHeader(req.headers.origin, allowedOriginHostnames);
        if (result.ok) {
            return true;
        }
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(
            JSON.stringify({
                jsonrpc: '2.0',
                error: {
                    code: -32_000,
                    message: result.message
                },
                id: null
            })
        );
        return false;
    };
}

/**
 * Convenience guard for localhost Origin validation.
 * Allows only origins whose hostname is `localhost`, `127.0.0.1`, or `[::1]` (IPv6 localhost).
 */
export function localhostOriginValidation(): (req: IncomingMessage, res: ServerResponse) => boolean {
    return originValidation(localhostAllowedOrigins());
}
