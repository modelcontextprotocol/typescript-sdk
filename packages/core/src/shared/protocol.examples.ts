/**
 * Type-checked examples for `protocol.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 * Each function's region markers define the code snippet that appears in the docs.
 *
 * @module
 */

import * as z from 'zod/v4';

import type { BaseContext, Protocol } from './protocol.js';

/**
 * Example: registering a handler for a custom (non-spec) request method.
 */
function Protocol_setRequestHandler_customMethod(protocol: Protocol<BaseContext>) {
    //#region Protocol_setRequestHandler_customMethod
    const SearchParams = z.object({ query: z.string(), limit: z.number().optional() });
    const SearchResult = z.object({ hits: z.array(z.string()) });

    protocol.setRequestHandler('acme/search', { params: SearchParams, result: SearchResult }, async (params, _ctx) => {
        return { hits: [`result for ${params.query}`] };
    });
    //#endregion Protocol_setRequestHandler_customMethod
    void protocol;
}

void Protocol_setRequestHandler_customMethod;
