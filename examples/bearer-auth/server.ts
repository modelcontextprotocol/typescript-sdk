/**
 * Minimal Resource-Server-only auth using the SDK's RS helpers
 * (`mcpAuthMetadataRouter`, `requireBearerAuth`, `OAuthTokenVerifier`).
 *
 * No Authorization Server in this repo — the metadata points at a placeholder
 * issuer; the token verifier accepts a single static `demo-token`. The MCP
 * endpoint is hosted on `createMcpHandler` with the verified `authInfo` passed
 * through to the factory (`ctx.authInfo`). HTTP-only by definition.
 */
import { parseExampleArgs } from '@mcp-examples/shared';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/express';
import {
    createMcpExpressApp,
    getOAuthProtectedResourceMetadataUrl,
    mcpAuthMetadataRouter,
    requireBearerAuth
} from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { AuthInfo, McpServerFactory, OAuthMetadata } from '@modelcontextprotocol/server';
import { createMcpHandler, McpServer, OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const buildServer: McpServerFactory = ctx => {
    const server = new McpServer({ name: 'bearer-auth-example', version: '1.0.0' });
    server.registerTool('whoami', { description: 'Returns the authenticated subject.', inputSchema: z.object({}) }, async () => ({
        content: [{ type: 'text', text: `client=${ctx.authInfo?.clientId ?? 'anon'}` }]
    }));
    return server;
};

const { port } = parseExampleArgs();
const mcpServerUrl = new URL(`http://localhost:${port}/mcp`);

const oauthMetadata: OAuthMetadata = {
    issuer: 'https://auth.example.com',
    authorization_endpoint: 'https://auth.example.com/authorize',
    token_endpoint: 'https://auth.example.com/token',
    response_types_supported: ['code']
};

// Replace with JWT verification, RFC 7662 introspection, etc.
const staticTokenVerifier: OAuthTokenVerifier = {
    async verifyAccessToken(token): Promise<AuthInfo> {
        if (token !== 'demo-token') {
            throw new OAuthError(OAuthErrorCode.InvalidToken, 'unknown token');
        }
        return { token, clientId: 'demo-client', scopes: ['mcp'], expiresAt: Math.floor(Date.now() / 1000) + 3600 };
    }
};

// Bearer auth is HTTP-layer (no stdio arm). The MCP handler is the canonical
// `createMcpHandler(buildServer)`; the Express auth middleware in front of it
// is the point of this story.
const handler = createMcpHandler(buildServer);

const app = createMcpExpressApp();
app.use(
    mcpAuthMetadataRouter({
        oauthMetadata,
        resourceServerUrl: mcpServerUrl,
        resourceName: 'bearer-auth example'
    })
);
const auth = requireBearerAuth({
    verifier: staticTokenVerifier,
    requiredScopes: ['mcp'],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpServerUrl)
});
// `requireBearerAuth` sets `req.auth`; `toNodeHandler` reads it and passes it
// to the factory as `ctx.authInfo`.
const node = toNodeHandler(handler);
app.all('/mcp', auth, (req, res) => void node(req, res, req.body));

app.listen(port, () => {
    console.error(`[server] listening on http://127.0.0.1:${port}/mcp`);
});
