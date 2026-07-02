// docs: typecheck-only
/**
 * Companion example for `docs/serving/authorization.md`.
 *
 * Every `ts` fence on that page except the web-standard one (sourced from
 * `authorization.web.examples.ts`) is synced from a `//#region` in this file
 * (`pnpm sync:snippets --check`). The Express middleware needs a listening
 * HTTP server and a real authorization server to exercise, so this file only
 * typechecks:
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *
 * @module
 */
//#region requireBearerAuth_basic
import type { OAuthTokenVerifier } from '@modelcontextprotocol/express';
import {
    createMcpExpressApp,
    getOAuthProtectedResourceMetadataUrl,
    mcpAuthMetadataRouter,
    requireBearerAuth
} from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { AuthInfo, OAuthMetadata } from '@modelcontextprotocol/server';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';

const mcpServerUrl = new URL('https://api.example.com/mcp');
const verifier: OAuthTokenVerifier = { verifyAccessToken };

const auth = requireBearerAuth({
    verifier,
    requiredScopes: ['mcp'],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpServerUrl)
});

const app = createMcpExpressApp({ host: '0.0.0.0', allowedHosts: ['api.example.com'] });
const node = toNodeHandler(createMcpHandler(buildServer));
app.all('/mcp', auth, (req, res) => void node(req, res, req.body));
//#endregion requireBearerAuth_basic

//#region tokenVerifier_basic
async function verifyAccessToken(token: string): Promise<AuthInfo> {
    const payload = await verifyJwt(token);
    return { token, clientId: payload.sub, scopes: payload.scopes, expiresAt: payload.exp };
}
//#endregion tokenVerifier_basic

// Stand-in for your JWT library or RFC 7662 introspection call.
declare function verifyJwt(token: string): Promise<{ sub: string; scopes: string[]; exp: number }>;

// Your authorization server's RFC 8414 metadata document — fetch it from the AS
// at startup or embed it.
const oauthMetadata: OAuthMetadata = {
    issuer: 'https://auth.example.com',
    authorization_endpoint: 'https://auth.example.com/authorize',
    token_endpoint: 'https://auth.example.com/token',
    response_types_supported: ['code']
};

//#region metadataRouter_basic
app.use(mcpAuthMetadataRouter({ oauthMetadata, resourceServerUrl: mcpServerUrl }));
//#endregion metadataRouter_basic

// The per-request factory from the Express recipe; the lead block mounts it behind `auth`.
function buildServer(): McpServer {
    const server = new McpServer({ name: 'notes', version: '1.0.0' });

    //#region authInfo_handler
    server.registerTool('whoami', { description: 'Report the authenticated caller' }, async ctx => {
        const caller = ctx.http?.authInfo;
        return { content: [{ type: 'text', text: `${caller?.clientId} [${caller?.scopes.join(' ')}]` }] };
    });
    //#endregion authInfo_handler

    //#region perToolScopes_handler
    server.registerTool('purge-notes', { description: 'Delete every note' }, async ctx => {
        if (!ctx.http?.authInfo?.scopes.includes('notes:write')) {
            return { content: [{ type: 'text', text: 'insufficient_scope: purge-notes requires notes:write' }], isError: true };
        }
        return { content: [{ type: 'text', text: 'All notes deleted' }] };
    });
    //#endregion perToolScopes_handler

    return server;
}
