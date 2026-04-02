import { localhostAllowedHostnames, validateHostHeader } from '@modelcontextprotocol/server';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Fastify onRequest hook for DNS rebinding protection.
 * Validates `Host` header hostname (port-agnostic) against an allowed list.
 *
 * This is particularly important for servers without authorization or HTTPS,
 * such as localhost servers or development servers. DNS rebinding attacks can
 * bypass same-origin policy by manipulating DNS to point a domain to a
 * localhost address, allowing malicious websites to access your local server.
 *
 * @param allowedHostnames - List of allowed hostnames (without ports).
 *   For IPv6, provide the address with brackets (e.g., `[::1]`).
 * @returns Fastify onRequest hook handler
 *
 * @example
 * ```ts source="./hostHeaderValidation.examples.ts#hostHeaderValidation_basicUsage"
 * app.addHook('onRequest', hostHeaderValidation(['localhost', '127.0.0.1', '[::1]']));
 * ```
 */
export function hostHeaderValidation(allowedHostnames: string[]) {
    return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
        const result = validateHostHeader(request.headers.host, allowedHostnames);
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
 * Convenience hook for localhost DNS rebinding protection.
 * Allows only `localhost`, `127.0.0.1`, and `[::1]` (IPv6 localhost) hostnames.
 *
 * @example
 * ```ts source="./hostHeaderValidation.examples.ts#localhostHostValidation_basicUsage"
 * app.addHook('onRequest', localhostHostValidation());
 * ```
 */
export function localhostHostValidation() {
    return hostHeaderValidation(localhostAllowedHostnames());
}
