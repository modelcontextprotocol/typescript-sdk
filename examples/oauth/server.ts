/**
 * In-repo OAuth-protected MCP server for the **authorization-code** flow — the
 * demo Resource Server that {@link ./client.ts} (headless, CI) and
 * {@link ./simpleOAuthClient.ts} (manual, real browser) authenticate against.
 *
 * One process, two listeners on adjacent ports:
 *
 *  - `:PORT+1` — the demo **Authorization Server** (`setupAuthServer` from
 *    `@mcp-examples/shared`, backed by better-auth's OIDC plugin). It
 *    implements the `authorization_code` grant only and auto-signs-in a fixed
 *    demo user. With `OAUTH_DEMO_AUTO_CONSENT=1` it also **auto-consents** —
 *    the `/authorize` endpoint skips the consent UI and 302s straight back to
 *    `redirect_uri?code=...`, so the whole browser dance becomes a chain of
 *    redirects a headless client can follow.
 *  - `:PORT` — the MCP **Resource Server**: `createMcpHandler` behind
 *    `requireBearerAuth({ verifier: demoTokenVerifier })`, advertising the AS
 *    via `createProtectedResourceMetadataRouter` (RFC 9728) so the client's
 *    discovery from a `401` `WWW-Authenticate` challenge works.
 *
 * DEMO ONLY — NOT FOR PRODUCTION. The demo AS auto-approves a fixed user; CORS
 * allows every origin; tokens are validated in-process against the same demo
 * AS instance.
 */
import { createProtectedResourceMetadataRouter, demoTokenVerifier, setupAuthServer } from '@mcp-examples/shared';
import { createMcpExpressApp, getOAuthProtectedResourceMetadataUrl, requireBearerAuth } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import cors from 'cors';
import * as z from 'zod/v4';

const argv = process.argv.slice(2);
const portIdx = argv.indexOf('--port');
const MCP_PORT = portIdx === -1 ? Number(process.env.MCP_PORT ?? 3000) : Number(argv[portIdx + 1]);
const AUTH_PORT = process.env.MCP_AUTH_PORT ? Number.parseInt(process.env.MCP_AUTH_PORT, 10) : MCP_PORT + 1;
// 127.0.0.1 (not `localhost`) so the PRM `resource` value matches the URL the
// harness passes the client byte-for-byte — the SDK auth driver enforces that.
const mcpServerUrl = new URL(`http://127.0.0.1:${MCP_PORT}/mcp`);
const authServerUrl = new URL(`http://127.0.0.1:${AUTH_PORT}`);

// ---- Authorization Server (better-auth OIDC; authorization_code only) ----
// `autoConsent` is the demo-only switch that turns the consent screen into an
// immediate 302 — set by the harness so `./client.ts` can run without a browser.
setupAuthServer({ authServerUrl, mcpServerUrl, demoMode: true, autoConsent: process.env.OAUTH_DEMO_AUTO_CONSENT === '1' });

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
// `requireBearerAuth` sets `req.auth`; `toNodeHandler` reads it and passes it
// to the factory as `ctx.authInfo`.
const node = toNodeHandler(handler);
app.all('/mcp', auth, (req, res) => void node(req, res, req.body));

app.listen(MCP_PORT, () => {
    console.error(`OAuth-protected MCP server listening on ${mcpServerUrl.href}`);
    console.error(`  Protected Resource Metadata: http://127.0.0.1:${MCP_PORT}/.well-known/oauth-protected-resource/mcp`);
});
