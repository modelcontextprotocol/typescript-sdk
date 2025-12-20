import type { BearerAuthMiddlewareOptions } from '@modelcontextprotocol/server';
import { requireBearerAuth as requireBearerAuthWeb } from '@modelcontextprotocol/server';
import type { MiddlewareHandler } from 'hono';
/**
 * Hono middleware wrapper for the Web-standard `requireBearerAuth` helper.
 *
 * On success, sets `c.set('auth', authInfo)` and calls `next()`.
 * On failure, returns the JSON error response.
 */
export function requireBearerAuth(options: BearerAuthMiddlewareOptions): MiddlewareHandler {
    return async (c, next) => {
        const result = await requireBearerAuthWeb(c.req.raw, options);
        if ('authInfo' in result) {
            c.set('auth', result.authInfo);
            return await next();
        }
        return result.response;
    };
}
