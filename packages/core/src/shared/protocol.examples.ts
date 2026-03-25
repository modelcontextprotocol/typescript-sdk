/**
 * Type-checked examples for `protocol.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 * Each function's region markers define the code snippet that appears in the docs.
 *
 * @module
 */

import type { BaseContext, Protocol } from './protocol.js';

/**
 * Example: Wrapping an existing request handler with getRequestHandler.
 */
function getRequestHandler_wrapping(protocol: Protocol<BaseContext>) {
    //#region getRequestHandler_wrapping
    const original = protocol.getRequestHandler('tools/list');
    if (original) {
        protocol.setRequestHandler('tools/list', async (request, ctx) => {
            const result = await original(request, ctx);
            // Transform the result before returning
            return result;
        });
    }
    //#endregion getRequestHandler_wrapping
}
