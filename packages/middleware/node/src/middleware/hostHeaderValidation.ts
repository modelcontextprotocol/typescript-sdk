import type { IncomingMessage, ServerResponse } from 'node:http';

import { localhostAllowedHostnames, validateHostHeader } from '@modelcontextprotocol/server';

/**
 * Node.js request guard for DNS rebinding protection.
 * Validates the `Host` header hostname (port-agnostic) against an allowed list.
 *
 * Unlike the framework adapters, plain `node:http` has no middleware chain, so
 * the guard returns whether the request may proceed: when it returns `false`
 * it has already answered the request with a `403` JSON-RPC error and the
 * caller must not handle it further.
 *
 * @param allowedHostnames - List of allowed hostnames (without ports).
 *   For IPv6, provide the address with brackets (e.g., `[::1]`).
 *
 * @example
 * ```ts
 * const validateHost = hostHeaderValidation(['localhost', '127.0.0.1', '[::1]']);
 * http.createServer((req, res) => {
 *     if (!validateHost(req, res)) return;
 *     void transport.handleRequest(req, res);
 * });
 * ```
 */
export function hostHeaderValidation(allowedHostnames: string[]): (req: IncomingMessage, res: ServerResponse) => boolean {
    return (req, res) => {
        const result = validateHostHeader(req.headers.host, allowedHostnames);
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
 * Convenience guard for localhost DNS rebinding protection.
 * Allows only `localhost`, `127.0.0.1`, and `[::1]` (IPv6 localhost) hostnames.
 */
export function localhostHostValidation(): (req: IncomingMessage, res: ServerResponse) => boolean {
    return hostHeaderValidation(localhostAllowedHostnames());
}
