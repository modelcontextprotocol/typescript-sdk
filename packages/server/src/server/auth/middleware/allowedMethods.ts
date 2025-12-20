import { MethodNotAllowedError } from '@modelcontextprotocol/core';

import { jsonResponse } from '../web.js';

/**
 * Helper to handle unsupported HTTP methods with a 405 Method Not Allowed response.
 *
 * @param allowedMethods Array of allowed HTTP methods for this endpoint (e.g., ['GET', 'POST'])
 * @returns Response if method not in allowed list, otherwise undefined
 */
export function allowedMethods(allowedMethods: string[], req: Request): Response | undefined {
    if (allowedMethods.includes(req.method)) {
        return undefined;
    }
    const error = new MethodNotAllowedError(`The method ${req.method} is not allowed for this endpoint`);
    return jsonResponse(error.toResponseObject(), {
        status: 405,
        headers: { Allow: allowedMethods.join(', ') }
    });
}
