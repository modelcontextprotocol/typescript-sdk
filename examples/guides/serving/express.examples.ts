/**
 * Runnable, type-checked companion for `docs-v2/serving/express.md`.
 *
 * Each `//#region` block is synced byte-for-byte into that page's code fences by
 * `pnpm sync:snippets` (`pnpm sync:snippets --check` reports drift). The
 * `createMcpExpressApp_listen` region lives in a wrapper function that is never
 * invoked, so running this file never binds a port; the harness below the
 * regions produces the response the page's "Run it and verify" section quotes
 * verbatim and exits non-zero if it drifts.
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *     npx tsx guides/serving/express.examples.ts        # from examples/
 *
 * @module
 */
/* eslint-disable no-console */
import type { OAuthTokenVerifier } from '@modelcontextprotocol/express';

//#region createMcpExpressApp_mount
import { createMcpExpressApp } from '@modelcontextprotocol/express';
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

const app = createMcpExpressApp();
const node = toNodeHandler(handler);
app.all('/mcp', (req, res) => void node(req, res, req.body));
//#endregion createMcpExpressApp_mount

//#region createMcpExpressApp_allowedHosts
const publicApp = createMcpExpressApp({ host: '0.0.0.0', allowedHosts: ['api.example.com'] });
//#endregion createMcpExpressApp_allowedHosts

// `verifier` stands in for your deployment's token verification (JWT
// validation, RFC 7662 introspection, a call to your IdP). The page points at
// docs-v2/serving/authorization.md for the real thing.
const verifier: OAuthTokenVerifier = {
    async verifyAccessToken(token) {
        return { token, clientId: 'docs-harness', scopes: ['mcp'], expiresAt: Date.now() / 1000 + 3600 };
    }
};

//#region requireBearerAuth_mount
import { requireBearerAuth } from '@modelcontextprotocol/express';

const auth = requireBearerAuth({ verifier });
publicApp.all('/mcp', auth, (req, res) => void node(req, res, req.body));
//#endregion requireBearerAuth_mount

// "Run it and verify" — the listen line. Never invoked: docs companions must
// terminate on their own and never bind a port.
function createMcpExpressApp_listen(): void {
    //#region createMcpExpressApp_listen
    app.listen(3000);
    //#endregion createMcpExpressApp_listen
}

// ---------------------------------------------------------------------------
// Harness (not shown on the page). The page quotes the response to its curl
// command verbatim; this produces it. The Express route is
// `(req, res) => void node(req, res, req.body)` with `node = toNodeHandler(handler)`,
// and `toNodeHandler` copies `handler.fetch(request)`'s status, headers, and
// body onto `res` unchanged — so `handler.fetch` given the curl command's exact
// request yields the bytes curl prints. (Driving the Express stack itself needs
// a listening socket, which a docs companion never opens.)
// ---------------------------------------------------------------------------

const response = await handler.fetch(
    new Request('http://127.0.0.1:3000/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    })
);
const text = await response.text();
console.log(text);

const quotedOnPage =
    'event: message\n' +
    'data: {"result":{"tools":[{"name":"add-note","description":"Append a note","inputSchema":{"type":"object",' +
    '"$schema":"https://json-schema.org/draft/2020-12/schema","properties":{"text":{"type":"string"}},"required":["text"]}}]},"jsonrpc":"2.0","id":1}';
if (response.status !== 200 || text.trimEnd() !== quotedOnPage) {
    throw new Error(`express.md "Run it and verify" output drifted from the SDK: ${JSON.stringify(text)}`);
}
