import { localhostAllowedOrigins, validateOriginHeader } from '@modelcontextprotocol/server';
import type { MiddlewareHandler } from 'hono';

/**
 * Hono middleware for Origin header validation.
 * Validates the `Origin` header hostname (port-agnostic) against an allowed list.
 *
 * Requests without an `Origin` header pass (non-browser MCP clients do not send
 * one); a present value that is not allowed, or that cannot be parsed, is
 * rejected with `403`.
 */
export function originValidation(allowedOriginHostnames: string[]): MiddlewareHandler {
    return async (c, next) => {
        const result = validateOriginHeader(c.req.header('origin'), allowedOriginHostnames);
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
 * Convenience middleware for localhost Origin validation.
 * Allows only origins whose hostname is `localhost`, `127.0.0.1`, or `[::1]` (IPv6 localhost).
 */
export function localhostOriginValidation(): MiddlewareHandler {
    return originValidation(localhostAllowedOrigins());
}
