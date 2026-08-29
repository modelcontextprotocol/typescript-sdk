/**
 * Type-checked examples for `dpopAuth.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 * Each function's region markers define the code snippet that appears in the docs.
 *
 * @module
 */

import type { AuthInfo } from '@modelcontextprotocol/core-internal';

import type { McpHttpHandler } from '../createMcpHandler';
import type { DpopAuthOptions } from './dpopAuth';
import { requireDpopAuth } from './dpopAuth';

/**
 * Example: gating a web-standard fetch handler with a DPoP-bound token.
 */
function requireDpopAuth_fetchGate(verifier: DpopAuthOptions['verifier'], handler: McpHttpHandler) {
    //#region requireDpopAuth_fetchGate
    const gate = requireDpopAuth({ verifier, requiredScopes: ['mcp'] });

    async function fetchHandler(request: Request): Promise<Response> {
        const auth: AuthInfo | Response = await gate(request);
        if (auth instanceof Response) return auth;
        return handler.fetch(request, { authInfo: auth });
    }
    //#endregion requireDpopAuth_fetchGate
    return fetchHandler;
}
