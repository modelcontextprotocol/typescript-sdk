/**
 * Type-checked examples for `oauthMetadata.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 * Each function's region markers define the code snippet that appears in the docs.
 *
 * @module
 */

import type { AuthMetadataOptions } from './oauthMetadata';
import { oauthMetadataResponse } from './oauthMetadata';

/**
 * Example: serving the discovery documents from a fetch handler.
 */
function oauthMetadataResponse_fetchHandler(options: AuthMetadataOptions, serveMcp: (request: Request) => Promise<Response>) {
    //#region oauthMetadataResponse_fetchHandler
    async function fetchHandler(request: Request): Promise<Response> {
        return oauthMetadataResponse(request, options) ?? serveMcp(request);
    }
    //#endregion oauthMetadataResponse_fetchHandler
    return fetchHandler;
}
