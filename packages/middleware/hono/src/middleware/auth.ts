import { Context, Next } from 'hono';
import { Authenticator, AuthInfo } from '@modelcontextprotocol/server';

/**
 * Options for the MCP Hono authentication middleware.
 */
export interface AuthMiddlewareOptions {
    /**
     * The authenticator to use for validating requests.
     */
    authenticator: Authenticator;
}

/**
 * Creates a Hono middleware for MCP authentication.
 *
 * This middleware extracts authentication information from the raw request using the provided authenticator
 * and attaches it to the Hono context as `mcpAuthInfo`.
 *
 * @param options - Middleware options
 * @returns A Hono middleware function
 *
 * @example
 * ```ts
 * const authenticator = new BearerTokenAuthenticator({
 *   validate: async (token) => ({ name: 'user', scopes: ['read'] })
 * });
 * app.use('/mcp/*', auth({ authenticator }));
 *
 * app.all('/mcp', async (c) => {
 *   const authInfo = c.get('mcpAuthInfo');
 *   return transport.handleRequest(c.req.raw, { authInfo });
 * });
 * ```
 */
export function auth(options: AuthMiddlewareOptions) {
    return async (c: Context, next: Next) => {
        try {
            const headers: Record<string, string> = {};
            c.req.raw.headers.forEach((v, k) => {
                headers[k] = v;
            });

            const authInfo = await options.authenticator.authenticate({
                method: c.req.method,
                headers,
            });

            if (authInfo) {
                c.set('mcpAuthInfo', authInfo);
            }
            await next();
        } catch (error) {
            // Proceed to allow MCP server to handle it or if auth is optional.
            await next();
        }
    };
}
