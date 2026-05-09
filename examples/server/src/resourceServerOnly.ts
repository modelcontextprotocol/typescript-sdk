/**
 * Minimal Resource-Server-only auth using the SDK's RS helpers
 * (`mcpAuthMetadataRouter`, `requireBearerAuth`, `OAuthTokenVerifier`).
 *
 * No better-auth. The Authorization Server is external; this example points
 * its metadata at a placeholder issuer. For a full AS+RS setup with a real
 * demo Authorization Server, see {@link ./simpleStreamableHttp.ts}.
 *
 * Run: pnpm tsx src/resourceServerOnly.ts
 * Probe: curl http://localhost:3000/.well-known/oauth-protected-resource/mcp
 *        curl -H 'Authorization: Bearer demo-token' -X POST http://localhost:3000/mcp ...
 */

import type { OAuthTokenVerifier } from '@modelcontextprotocol/express';
import {
    createMcpExpressApp,
    getOAuthProtectedResourceMetadataUrl,
    mcpAuthMetadataRouter,
    requireBearerAuth
} from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { AuthInfo, CallToolResult, OAuthMetadata } from '@modelcontextprotocol/server';
import { McpServer, OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import type { Request, Response } from 'express';
import * as z from 'zod/v4';

const PORT = 3000;
const mcpServerUrl = new URL(`http://localhost:${PORT}/mcp`);

// In a real deployment this is your external Authorization Server's metadata
// (RFC 8414). The SDK router serves it verbatim at
// /.well-known/oauth-authorization-server so clients probing the RS origin
// can still discover the AS.
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

const server = new McpServer({ name: 'rs-only', version: '1.0.0' }, { capabilities: {} });
server.registerTool(
    'whoami',
    { description: 'Returns the authenticated subject.', inputSchema: z.object({}) },
    async (_args, ctx): Promise<CallToolResult> => ({
        content: [{ type: 'text', text: `client=${ctx.http?.authInfo?.clientId ?? 'anon'}` }]
    })
);

const app = createMcpExpressApp();

app.use(
    mcpAuthMetadataRouter({
        oauthMetadata,
        resourceServerUrl: mcpServerUrl,
        resourceName: 'RS-only example'
    })
);

const auth = requireBearerAuth({
    verifier: staticTokenVerifier,
    requiredScopes: ['mcp'],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpServerUrl)
});

app.post('/mcp', auth, async (req: Request, res: Response) => {
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => void transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, () => {
    console.log(`RS-only MCP server on http://localhost:${PORT}/mcp`);
    console.log(`  PRM: ${getOAuthProtectedResourceMetadataUrl(mcpServerUrl)}`);
    console.log(`  AS metadata mirror: http://localhost:${PORT}/.well-known/oauth-authorization-server`);
});
