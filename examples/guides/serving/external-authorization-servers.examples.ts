// docs: typecheck-only
/**
 * Companion example for `docs/serving/external-authorization-servers.md`.
 *
 * Every `ts` fence on that page is synced from a `//#region` in this file
 * (`pnpm sync:snippets --check`). Both styles need a live Authorization
 * Server to exercise, so this file only typechecks:
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *
 * @module
 */
import type { AuthInfo, McpHttpHandler, OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { createMcpHandler, McpServer, OAuthError, OAuthErrorCode, requireBearerAuth } from '@modelcontextprotocol/server';

declare function buildServer(): McpServer;
declare function verifyJwtAgainstIssuer(token: string): Promise<{ sub: string; scopes: string[]; exp: number }>;

const handler: McpHttpHandler = createMcpHandler(buildServer);

//#region styleA_injectAuthInfo
// The fronting provider verified the token and hands your handler the identity
// it stored at grant time (workers-oauth-provider: `ctx.props`). Map it.
interface GrantProps {
    clientId: string;
    scopes: string[];
}

async function serveVerified(request: Request, props: GrantProps): Promise<Response> {
    const authInfo: AuthInfo = {
        token: request.headers.get('authorization')?.replace(/^Bearer /i, '') ?? '',
        clientId: props.clientId,
        scopes: props.scopes
        // No expiresAt: the provider enforces validity on every request.
    };
    return handler.fetch(request, { authInfo });
}
//#endregion styleA_injectAuthInfo

//#region styleB_externalVerifier
// The AS is external (an IdP issuing JWTs): verify each request yourself.
const verifier: OAuthTokenVerifier = {
    async verifyAccessToken(token): Promise<AuthInfo> {
        const payload = await verifyJwtAgainstIssuer(token).catch(() => {
            throw new OAuthError(OAuthErrorCode.InvalidToken, 'unknown token');
        });
        return { token, clientId: payload.sub, scopes: payload.scopes, expiresAt: payload.exp };
    }
};
const gate = requireBearerAuth({ verifier, requiredScopes: ['mcp'] });

async function fetchHandler(request: Request): Promise<Response> {
    const auth = await gate(request);
    if (auth instanceof Response) return auth;
    return handler.fetch(request, { authInfo: auth });
}
//#endregion styleB_externalVerifier

void serveVerified;
void fetchHandler;
