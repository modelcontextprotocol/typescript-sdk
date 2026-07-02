/**
 * Type-checked examples for `bearerAuth.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 * Each function's region markers define the code snippet that appears in the docs.
 *
 * @module
 */

import type { AuthInfo } from '@modelcontextprotocol/core-internal';

import type { McpHttpHandler } from '../createMcpHandler';
import type { OAuthTokenVerifier } from './bearerAuth';
import { requireBearerAuth } from './bearerAuth';

/**
 * Example: gating a web-standard fetch handler with a Bearer token.
 */
function requireBearerAuth_fetchGate(verifier: OAuthTokenVerifier, handler: McpHttpHandler) {
    //#region requireBearerAuth_fetchGate
    const gate = requireBearerAuth({ verifier, requiredScopes: ['mcp'] });

    async function fetchHandler(request: Request): Promise<Response> {
        const auth: AuthInfo | Response = await gate(request);
        if (auth instanceof Response) return auth;
        return handler.fetch(request, { authInfo: auth });
    }
    //#endregion requireBearerAuth_fetchGate
    return fetchHandler;
}
