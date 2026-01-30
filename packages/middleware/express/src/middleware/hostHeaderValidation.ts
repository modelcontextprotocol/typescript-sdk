import { localhostAllowedHostnames, validateHostHeader } from '@modelcontextprotocol/server';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Express middleware for DNS rebinding protection.
 * Validates Host header hostname (port-agnostic) against an allowed list.
 *
 * This is particularly important for servers without authorization or HTTPS,
 * such as localhost servers or development servers. DNS rebinding attacks can
 * bypass same-origin policy by manipulating DNS to point a domain to a
 * localhost address, allowing malicious websites to access your local server.
 *
 * @param allowedHostnames - List of allowed hostnames (without ports).
 *   For IPv6, provide the address with brackets (e.g., '[::1]').
 * @returns Express middleware function
 *
 * @example
 * ```typescript
 * const middleware = hostHeaderValidation(['localhost', '127.0.0.1', '[::1]']);
 * app.use(middleware);
 * ```
 */
export function hostHeaderValidation(allowedHostnames: string[]): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
        const result = validateHostHeader(req.headers.host, allowedHostnames);
        if (!result.ok) {
            res.status(403).json({
                jsonrpc: '2.0',
                error: {
                    code: -32_000,
                    message: result.message
                },
                id: null
            });
            return;
        }
        next();
    };
}

/**
 * Convenience middleware for localhost DNS rebinding protection.
 * Allows only localhost, 127.0.0.1, and [::1] (IPv6 localhost) hostnames.
 *
 * @example
 * ```typescript
 * app.use(localhostHostValidation());
 * ```
 */
export function localhostHostValidation(): RequestHandler {
    return hostHeaderValidation(localhostAllowedHostnames());
}
