import { localhostAllowedOrigins, validateOriginHeader } from '@modelcontextprotocol/server';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Fastify onRequest hook for Origin header validation.
 * Validates the `Origin` header hostname (port-agnostic) against an allowed list.
 *
 * Browsers attach an `Origin` header to cross-origin requests; validating it —
 * alongside Host header validation — protects localhost and development servers
 * against DNS rebinding and cross-site request forgery. Requests without an
 * `Origin` header pass (non-browser MCP clients do not send one); a present
 * value that is not allowed, or that cannot be parsed, is rejected with `403`.
 *
 * @param allowedOriginHostnames - List of allowed origin hostnames (without scheme or port).
 *   For IPv6, provide the address with brackets (e.g., `[::1]`).
 * @returns Fastify onRequest hook handler
 *
 * @example
 * ```ts
 * app.addHook('onRequest', originValidation(['localhost', '127.0.0.1', '[::1]']));
 * ```
 */
export function originValidation(allowedOriginHostnames: string[]) {
    return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
        const result = validateOriginHeader(request.headers.origin, allowedOriginHostnames);
        if (!result.ok) {
            await reply.code(403).send({
                jsonrpc: '2.0',
                error: {
                    code: -32_000,
                    message: result.message
                },
                id: null
            });
        }
    };
}

/**
 * Convenience hook for localhost Origin validation.
 * Allows only origins whose hostname is `localhost`, `127.0.0.1`, or `[::1]` (IPv6 localhost).
 *
 * @example
 * ```ts
 * app.addHook('onRequest', localhostOriginValidation());
 * ```
 */
export function localhostOriginValidation() {
    return originValidation(localhostAllowedOrigins());
}
