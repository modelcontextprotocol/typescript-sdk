/**
 * Type-checked examples for `hostHeaderValidation.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 * Each function's region markers define the code snippet that appears in the docs.
 *
 * @module
 */

import { validateHostHeader } from './hostHeaderValidation.js';

/**
 * Example: Validating a host header against allowed hosts.
 */
function hostHeaderValidationResponse_basicUsage(req: Request) {
    //#region hostHeaderValidationResponse_basicUsage
    const result = validateHostHeader(req.headers.get('host'), ['localhost']);
    //#endregion hostHeaderValidationResponse_basicUsage
    return result;
}
