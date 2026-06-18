/**
 * OAuth 2.0 **`client_credentials`** grant — the machine-to-machine story.
 *
 * One process hosts both halves on adjacent ports:
 *
 *  - `:PORT`   — the MCP **Resource Server**: `createMcpHandler` behind
 *    `requireBearerAuth`, advertising the AS via `mcpAuthMetadataRouter`
 *    (RFC 9728 Protected Resource Metadata + RFC 8414 AS metadata).
 *  - `:PORT+1` — a minimal in-repo **Authorization Server** that supports the
 *    `client_credentials` grant only (`@mcp-examples/shared`'s
 *    `createClientCredentialsAuthServer`). The full better-auth/OIDC demo AS
 *    only implements `authorization_code`, hence this purpose-built one.
 *
 * The client (`./client.ts`) discovers the AS from a 401 challenge, exchanges
 * its `client_id`/`client_secret` for a Bearer token at `/token`, and reaches
 * the `whoami` tool — which echoes `ctx.authInfo` so the client can assert the
 * granted scopes round-tripped end to end. HTTP-only by definition.
 */
import { createClientCredentialsAuthServer } from '@mcp-examples/shared';
import {
    createMcpExpressApp,
    getOAuthProtectedResourceMetadataUrl,
    mcpAuthMetadataRouter,
    requireBearerAuth
} from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const argv = process.argv.slice(2);
const portIdx = argv.indexOf('--port');
const PORT = portIdx === -1 ? 3000 : Number(argv[portIdx + 1]);
const AUTH_PORT = PORT + 1;
// 127.0.0.1 (not `localhost`) so the PRM `resource` value matches the URL the
// harness passes the client byte-for-byte — the SDK auth driver enforces that.
const mcpServerUrl = new URL(`http://127.0.0.1:${PORT}/mcp`);
const authServerUrl = new URL(`http://127.0.0.1:${AUTH_PORT}/`);

// Demo confidential client. DEMO ONLY — never hard-code real credentials.
export const DEMO_CLIENT = { clientId: 'demo-m2m-client', clientSecret: 'demo-m2m-secret', allowedScopes: ['mcp:tools', 'mcp:read'] };

// ---- Authorization Server (client_credentials only) ----
const as = createClientCredentialsAuthServer({ authServerUrl, clients: [DEMO_CLIENT] });
as.app.listen(AUTH_PORT, () => console.error(`[auth-server] client_credentials AS on ${authServerUrl.href}`));

// ---- Resource Server (MCP) ----
const handler = createMcpHandler(ctx => {
    const server = new McpServer({ name: 'oauth-client-credentials-example', version: '1.0.0' });
    server.registerTool(
        'whoami',
        { description: 'Returns the authenticated client and its granted scopes.', inputSchema: z.object({}) },
        async () => ({
            content: [{ type: 'text', text: JSON.stringify({ clientId: ctx.authInfo?.clientId, scopes: ctx.authInfo?.scopes }) }]
        })
    );
    return server;
});

const app = createMcpExpressApp();
app.use(
    mcpAuthMetadataRouter({
        oauthMetadata: as.metadata,
        resourceServerUrl: mcpServerUrl,
        scopesSupported: ['mcp:tools', 'mcp:read'],
        resourceName: 'oauth-client-credentials example'
    })
);
const auth = requireBearerAuth({
    verifier: as.verifier,
    requiredScopes: ['mcp:tools'],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpServerUrl)
});
// `requireBearerAuth` sets `req.auth`; `toNodeHandler` reads it and passes it
// to the factory as `ctx.authInfo`.
const node = toNodeHandler(handler);
app.all('/mcp', auth, (req, res) => void node(req, res, req.body));

app.listen(PORT, () => console.error(`[resource-server] MCP on ${mcpServerUrl.href}`));
