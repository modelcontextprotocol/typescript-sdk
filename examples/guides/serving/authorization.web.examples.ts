// docs: typecheck-only
/**
 * Companion example for the web-standard section of
 * `docs/serving/authorization.md`.
 *
 * Lives beside `authorization.examples.ts` in its own module because both
 * packages export a `requireBearerAuth`: the Express one is demonstrated
 * there, the web-standard one from `@modelcontextprotocol/server` here. Like
 * its sibling, this file only typechecks:
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *
 * @module
 */
import type { AuthInfo, OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { createMcpHandler, McpServer, OAuthError, OAuthErrorCode, requireBearerAuth } from '@modelcontextprotocol/server';

declare function verifyJwt(token: string): Promise<{ sub: string; scopes: string[]; exp: number }>;

const verifier: OAuthTokenVerifier = {
    async verifyAccessToken(token): Promise<AuthInfo> {
        const payload = await verifyJwt(token).catch(() => {
            throw new OAuthError(OAuthErrorCode.InvalidToken, 'unknown token');
        });
        return { token, clientId: payload.sub, scopes: payload.scopes, expiresAt: payload.exp };
    }
};

function buildServer(): McpServer {
    return new McpServer({ name: 'protected-server', version: '1.0.0' });
}

//#region requireBearerAuth_webStandard
const gate = requireBearerAuth({ verifier, requiredScopes: ['mcp'] });
const handler = createMcpHandler(buildServer);

export default {
    async fetch(request: Request): Promise<Response> {
        const auth = await gate(request);
        if (auth instanceof Response) return auth;
        return handler.fetch(request, { authInfo: auth });
    }
};
//#endregion requireBearerAuth_webStandard
