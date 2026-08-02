/**
 * Type-checked examples for `serverCard.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 * Each function's region markers define the code snippet that appears in the docs.
 *
 * @module
 */

import type { AICatalog, ServerCard } from './serverCard';
import { aiCatalogResponse, serverCardResponse } from './serverCard';

/**
 * Example: composing the card and catalog responders in front of an MCP
 * handler in a web-standard fetch host.
 */
function serverCardResponse_fetchHandler(
    card: ServerCard,
    catalog: AICatalog,
    mcpUrl: URL,
    serveMcp: (request: Request) => Promise<Response>
) {
    //#region serverCardResponse_fetchHandler
    async function fetchHandler(request: Request): Promise<Response> {
        return await (serverCardResponse(request, { card, mcpUrl }) ?? aiCatalogResponse(request, { catalog }) ?? serveMcp(request));
    }
    //#endregion serverCardResponse_fetchHandler
    return fetchHandler;
}
