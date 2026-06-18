/**
 * In-repo OAuth-protected MCP server for the interactive **authorization-code**
 * flow — the demo Resource Server that {@link ./simpleOAuthClient.ts}
 * authenticates against.
 *
 * One process, two listeners:
 *
 *  - `:AUTH_PORT` (default `3001`) — the demo **Authorization Server**
 *    (`setupAuthServer` from `@mcp-examples/shared`, backed by better-auth's
 *    OIDC plugin). It implements the `authorization_code` grant only and
 *    auto-signs-in a fixed demo user.
 *  - `:MCP_PORT` (default `3000`) — the MCP **Resource Server**:
 *    `createMcpHandler` behind `requireBearerAuth({ verifier: demoTokenVerifier })`,
 *    advertising the AS via `createProtectedResourceMetadataRouter` (RFC 9728)
 *    so the client's discovery from a `401` `WWW-Authenticate` challenge works.
 *
 * Excluded from the harness (the browser flow needs a real browser); run
 * manually — see `./README.md`.
 *
 * DEMO ONLY — NOT FOR PRODUCTION. The demo AS auto-approves a fixed user; CORS
 * allows every origin; tokens are validated in-process against the same demo
 * AS instance.
 */
import { createProtectedResourceMetadataRouter, demoTokenVerifier, setupAuthServer } from '@mcp-examples/shared';
import { createMcpExpressApp, getOAuthProtectedResourceMetadataUrl, requireBearerAuth } from '@modelcontextprotocol/express';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import cors from 'cors';
import * as z from 'zod/v4';

const MCP_PORT = process.env.MCP_PORT ? Number.parseInt(process.env.MCP_PORT, 10) : 3000;
const AUTH_PORT = process.env.MCP_AUTH_PORT ? Number.parseInt(process.env.MCP_AUTH_PORT, 10) : 3001;
const mcpServerUrl = new URL(`http://localhost:${MCP_PORT}/mcp`);
const authServerUrl = new URL(`http://localhost:${AUTH_PORT}`);

// ---- Authorization Server (better-auth OIDC; authorization_code only) ----
setupAuthServer({ authServerUrl, mcpServerUrl, demoMode: true });

// ---- Resource Server (MCP) ----
const handler = createMcpHandler(ctx => {
    const server = new McpServer({ name: 'oauth-protected-example', version: '1.0.0' });
    server.registerTool(
        'whoami',
        { description: 'Returns the authenticated subject and granted scopes.', inputSchema: z.object({}) },
        async () => ({
            content: [{ type: 'text', text: JSON.stringify({ clientId: ctx.authInfo?.clientId, scopes: ctx.authInfo?.scopes }) }]
        })
    );
    return server;
});

const app = createMcpExpressApp();
// DEMO ONLY — restrict `origin` in production. `exposedHeaders` lists the
// response headers a browser-based MCP client must be able to read.
app.use(
    cors({
        origin: '*',
        exposedHeaders: ['Mcp-Session-Id', 'WWW-Authenticate', 'Last-Event-Id', 'Mcp-Protocol-Version']
    })
);
// RFC 9728 Protected Resource Metadata at /.well-known/oauth-protected-resource/mcp
// — the client discovers the AS from the 401 challenge → this route → AS metadata.
app.use(createProtectedResourceMetadataRouter('/mcp'));

const auth = requireBearerAuth({
    verifier: demoTokenVerifier,
    requiredScopes: [],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpServerUrl)
});
// `requireBearerAuth` sets `req.auth`; `handler.node` reads it and passes it
// to the factory as `ctx.authInfo`.
app.all('/mcp', auth, (req, res) => void handler.node(req, res, req.body));

app.listen(MCP_PORT, () => {
    console.log(`OAuth-protected MCP server listening on ${mcpServerUrl.href}`);
    console.log(`  Protected Resource Metadata: http://localhost:${MCP_PORT}/.well-known/oauth-protected-resource/mcp`);
});
