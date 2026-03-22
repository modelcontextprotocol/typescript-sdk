import { Request, Response, NextFunction } from 'express';
import { Authenticator, AuthInfo } from '@modelcontextprotocol/server';

/**
 * Options for the MCP Express authentication middleware.
 */
export interface AuthMiddlewareOptions {
    /**
     * The authenticator to use for validating requests.
     */
    authenticator: Authenticator;
}

/**
 * Creates an Express middleware for MCP authentication.
 *
 * This middleware extracts authentication information from the request using the provided authenticator
 * and attaches it to the request object as `req.auth`. The MCP Express transport will then
 * pick up this information automatically.
 *
 * @param options - Middleware options
 * @returns An Express middleware function
 *
 * @example
 * ```ts
 * const authenticator = new BearerTokenAuthenticator({
 *   validate: async (token) => ({ name: 'user', scopes: ['read'] })
 * });
 * app.use(auth({ authenticator }));
 * ```
 */
export function auth(options: AuthMiddlewareOptions) {
    return async (req: Request & { auth?: AuthInfo }, res: Response, next: NextFunction) => {
        try {
            const headers: Record<string, string> = {};
            for (const [key, value] of Object.entries(req.headers)) {
                if (typeof value === 'string') {
                    headers[key] = value;
                } else if (Array.isArray(value)) {
                    headers[key] = value.join(', ');
                }
            }

            const authInfo = await options.authenticator.authenticate({
                method: req.method,
                headers,
            });
            if (authInfo) {
                req.auth = authInfo;
            }
            next();
        } catch (error) {
            // If authentication fails, we let the MCP server handle it later,
            // or the developer can choose to reject here.
            // By default, we just proceed to allow the MCP server to decide (e.g., if auth is optional).
            next();
        }
    };
}
