/**
 * Runnable, type-checked companion for `docs/serving/hono.md`.
 *
 * Each `//#region` block is synced byte-for-byte into that page's code fences by
 * `pnpm sync:snippets` (`pnpm sync:snippets --check` reports drift). The harness
 * below the regions drives the real Hono app in process with `app.request()`,
 * produces the response the page's "Run it and verify" section quotes verbatim,
 * and exits non-zero if it drifts. No port is ever bound.
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *     npx tsx guides/serving/hono.examples.ts        # from examples/
 *
 * @module
 */
/* eslint-disable no-console */
import type { AuthInfo } from '@modelcontextprotocol/server';

//#region mcp_mount
import { mcp } from '@modelcontextprotocol/hono';
import { McpServer } from '@modelcontextprotocol/server';
import { Hono } from 'hono';
import * as z from 'zod/v4';

const app = new Hono();
app.all(
    '/mcp',
    mcp(() => {
        const server = new McpServer({ name: 'notes', version: '1.0.0' });
        server.registerTool(
            'add-note',
            { description: 'Append a note', inputSchema: z.object({ text: z.string() }) },
            async ({ text }) => ({
                content: [{ type: 'text', text: `Saved: ${text}` }]
            })
        );
        return server;
    })
);

export default app;
//#endregion mcp_mount

//#region createMcpHonoApp_mount
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { Context } from 'hono';

const handler = createMcpHandler(() => {
    const factoryServer = new McpServer({ name: 'notes', version: '1.0.0' });
    factoryServer.registerTool(
        'add-note',
        { description: 'Append a note', inputSchema: z.object({ text: z.string() }) },
        async ({ text }) => ({
            content: [{ type: 'text', text: `Saved: ${text}` }]
        })
    );
    return factoryServer;
});

const factoryApp = createMcpHonoApp();
factoryApp.all('/mcp', (c: Context) => handler.fetch(c.req.raw, { parsedBody: c.get('parsedBody') }));
//#endregion createMcpHonoApp_mount

//#region createMcpHonoApp_allowedHosts
const publicApp = createMcpHonoApp({ host: '0.0.0.0', allowedHosts: ['api.example.com'] });
//#endregion createMcpHonoApp_allowedHosts

// `verifyToken` stands in for your deployment's token verification (JWT
// validation, RFC 7662 introspection, a call to your IdP). The page points at
// docs/serving/authorization.md for the real thing.
async function verifyToken(request: Request): Promise<AuthInfo> {
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    return { token, clientId: 'docs-harness', scopes: ['mcp'], expiresAt: Date.now() / 1000 + 3600 };
}

//#region McpHttpHandler_fetch_authInfo
publicApp.all('/mcp', async (c: Context) => {
    const authInfo = await verifyToken(c.req.raw);
    return handler.fetch(c.req.raw, { authInfo, parsedBody: c.get('parsedBody') });
});
//#endregion McpHttpHandler_fetch_authInfo

// ---------------------------------------------------------------------------
// Harness (not shown on the page). `app.request()` runs the real Hono app —
// the JSON body-parsing middleware, the Host/Origin validation, and the `/mcp`
// route — entirely in process. The page quotes its body verbatim.
// ---------------------------------------------------------------------------

const response = await app.request('/mcp', {
    method: 'POST',
    headers: { host: '127.0.0.1:8787', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
});
const text = await response.text();
console.log(text);

const quotedOnPage =
    'event: message\n' +
    'data: {"result":{"tools":[{"name":"add-note","description":"Append a note","inputSchema":{"type":"object",' +
    '"$schema":"https://json-schema.org/draft/2020-12/schema","properties":{"text":{"type":"string"}},"required":["text"]}}]},"jsonrpc":"2.0","id":1}';
if (response.status !== 200 || text.trimEnd() !== quotedOnPage) {
    throw new Error(`hono.md "Run it and verify" output drifted from the SDK: ${JSON.stringify(text)}`);
}
