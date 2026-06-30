/**
 * Runnable, type-checked companion for `docs/serving/fastify.md`.
 *
 * Each `//#region` block is synced byte-for-byte into that page's code fences by
 * `pnpm sync:snippets` (`pnpm sync:snippets --check` reports drift). The
 * `createMcpFastifyApp_listen` region lives in a wrapper function that is never
 * invoked, so running this file never binds a port; the harness below the
 * regions drives the real Fastify app in process with `app.inject()`, produces
 * the response the page's "Run it and verify" section quotes verbatim, and
 * exits non-zero if it drifts.
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *     npx tsx guides/serving/fastify.examples.ts        # from examples/
 *
 * @module
 */
/* eslint-disable no-console */
import type { AuthInfo } from '@modelcontextprotocol/server';

//#region createMcpFastifyApp_mount
import { createMcpFastifyApp } from '@modelcontextprotocol/fastify';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'notes', version: '1.0.0' });
    server.registerTool('add-note', { description: 'Append a note', inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({
        content: [{ type: 'text', text: `Saved: ${text}` }]
    }));
    return server;
});

const app = createMcpFastifyApp();
const node = toNodeHandler(handler);
app.all('/mcp', (request, reply) => node(request.raw, reply.raw, request.body));
//#endregion createMcpFastifyApp_mount

//#region createMcpFastifyApp_allowedHosts
const publicApp = createMcpFastifyApp({ host: '0.0.0.0', allowedHosts: ['api.example.com'] });
//#endregion createMcpFastifyApp_allowedHosts

// `verifyToken` stands in for your deployment's token verification (JWT
// validation, RFC 7662 introspection, a call to your IdP). The page points at
// docs/serving/authorization.md for the real thing.
async function verifyToken(authorization: string | undefined): Promise<AuthInfo> {
    const token = authorization?.replace(/^Bearer /, '') ?? '';
    return { token, clientId: 'docs-harness', scopes: ['mcp'], expiresAt: Date.now() / 1000 + 3600 };
}

//#region toNodeHandler_authInfo
publicApp.all('/mcp', async (request, reply) => {
    const auth = await verifyToken(request.headers.authorization);
    return node(Object.assign(request.raw, { auth }), reply.raw, request.body);
});
//#endregion toNodeHandler_authInfo

// "Run it and verify" — the listen line. Never invoked: docs companions must
// terminate on their own and never bind a port.
async function createMcpFastifyApp_listen(): Promise<void> {
    //#region createMcpFastifyApp_listen
    await app.listen({ port: 3000 });
    //#endregion createMcpFastifyApp_listen
}

// ---------------------------------------------------------------------------
// Harness (not shown on the page). `app.inject()` runs the real Fastify app —
// the Host/Origin validation hooks, the JSON body parser, and the `/mcp` route
// — entirely in process, no socket. The page quotes its payload verbatim.
// ---------------------------------------------------------------------------

const injected = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { host: '127.0.0.1:3000', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
});
console.log(injected.payload);

const quotedOnPage =
    'event: message\n' +
    'data: {"result":{"tools":[{"name":"add-note","description":"Append a note","inputSchema":{"type":"object",' +
    '"$schema":"https://json-schema.org/draft/2020-12/schema","properties":{"text":{"type":"string"}},"required":["text"]}}]},"jsonrpc":"2.0","id":1}';
if (injected.statusCode !== 200 || injected.payload.trimEnd() !== quotedOnPage) {
    throw new Error(`fastify.md "Run it and verify" output drifted from the SDK: ${JSON.stringify(injected.payload)}`);
}

await app.close();
await publicApp.close();
