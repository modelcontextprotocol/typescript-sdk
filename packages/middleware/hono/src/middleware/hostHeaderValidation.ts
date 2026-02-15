import { localhostAllowedHostnames, validateHostHeader } from '@modelcontextprotocol/server';
import type { MiddlewareHandler } from 'hono';

/**
 * Hono middleware for DNS rebinding protection.
 * Validates `Host` header hostname (port-agnostic) against an allowed list.
 */
export function hostHeaderValidation(allowedHostnames: string[]): MiddlewareHandler {
    return async (c, next) => {
        const result = validateHostHeader(c.req.header('host'), allowedHostnames);
        if (!result.ok) {
            return c.json(
                {
                    jsonrpc: '2.0',
                    error: {
                        code: -32_000,
                        message: result.message
                    },
                    id: null
                },
                403
            );
        }
        return await next();
    };
}

/**
 * Convenience middleware for `localhost` DNS rebinding protection.
 */
export function localhostHostValidation(): MiddlewareHandler {
    return hostHeaderValidation(localhostAllowedHostnames());
}
