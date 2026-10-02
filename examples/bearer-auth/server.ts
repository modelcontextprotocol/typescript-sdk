/**
 * Minimal Resource-Server-only auth: `requireBearerAuth` + `OAuthTokenVerifier`
 * in front of `createMcpHandler`. The verifier accepts a single static
 * `demo-token`; the verified `authInfo` reaches the factory as `ctx.authInfo`.
 *
 * No Authorization Server here, and no metadata endpoints — see `examples/oauth/`
 * for the full RS + AS discovery flow. HTTP-only by definition.
 */
import { parseExampleArgs } from '@mcp-examples/shared';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/express';
import { createMcpExpressApp, requireBearerAuth } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { AuthInfo, McpServerFactory } from '@modelcontextprotocol/server';
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
const mcpServerUrl = new URL(`http://127.0.0.1:${port}/mcp`);

// Replace with JWT verification, RFC 7662 introspection, etc.
const staticTokenVerifier: OAuthTokenVerifier = {
    async verifyAccessToken(token): Promise<AuthInfo> {
        if (token !== 'demo-token') {
            throw new OAuthError(OAuthErrorCode.InvalidToken, 'unknown token');
        }
        // `resource` says which server the token was issued for: the token's `aud` in a real verifier.
        return { token, clientId: 'demo-client', scopes: ['mcp'], expiresAt: Math.floor(Date.now() / 1000) + 3600, resource: mcpServerUrl };
    }
};

// Bearer auth is HTTP-layer (no stdio arm). The MCP handler is the canonical
// `createMcpHandler(buildServer)`; the Express auth middleware in front of it
// is the point of this story.
const handler = createMcpHandler(buildServer);

const app = createMcpExpressApp();
// `expectedResource`: only tokens the verifier reports as issued for this server are accepted.
const auth = requireBearerAuth({ verifier: staticTokenVerifier, requiredScopes: ['mcp'], expectedResource: mcpServerUrl });
// `requireBearerAuth` sets `req.auth`; `toNodeHandler` reads it and passes it
// to the factory as `ctx.authInfo`.
const node = toNodeHandler(handler);
app.all('/mcp', auth, (req, res) => void node(req, res, req.body));

app.listen(port, () => {
    console.error(`[server] listening on http://127.0.0.1:${port}/mcp`);
});
