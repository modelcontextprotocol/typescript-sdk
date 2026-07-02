/**
 * Companion example for `docs/serving/http.md`.
 *
 * Every `ts` fence on that page is synced from a `//#region` in this file
 * (`pnpm sync:snippets --check`). The file also runs: the harness below the
 * regions drives `handler.fetch` in process — no port, no socket — and
 * produces the output the page quotes verbatim.
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *     npx tsx guides/serving/http.examples.ts        # from examples/
 *
 * @module
 */
/* eslint-disable no-console */
import { createServer } from 'node:http';

import { toNodeHandler } from '@modelcontextprotocol/node';
import type { McpServerFactory } from '@modelcontextprotocol/server';

// ---------------------------------------------------------------------------
// "Create a handler"
// ---------------------------------------------------------------------------

//#region createHandler
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'notes', version: '1.0.0' });
    server.registerTool(
        'add-note',
        {
            description: 'Save a note',
            inputSchema: z.object({ text: z.string() })
        },
        async ({ text }) => ({ content: [{ type: 'text', text: `Saved: ${text}` }] })
    );
    return server;
});
//#endregion createHandler

// ---------------------------------------------------------------------------
// "Understand the per-request factory" — the factory reads the request context.
// ---------------------------------------------------------------------------

//#region factoryContext
const perCaller = createMcpHandler(({ authInfo }) => {
    const server = new McpServer({ name: 'notes', version: '1.0.0' });
    server.registerTool('whoami', { description: 'Name the authenticated caller' }, async () => ({
        content: [{ type: 'text', text: authInfo?.clientId ?? 'anonymous' }]
    }));
    return server;
});
//#endregion factoryContext

// ---------------------------------------------------------------------------
// "Mount it on your runtime" — never invoked: binding a port is the reader's
// deployment step, not this program's. The region typechecks against the real
// module-scope `handler` above.
// ---------------------------------------------------------------------------

/** Example: mounting the handler on plain `node:http`. */
function mountNode(): void {
    //#region mountNode
    createServer(toNodeHandler(handler)).listen(3000);
    //#endregion mountNode
}
void mountNode;

// ---------------------------------------------------------------------------
// "Validate Host and Origin in front of it" / "Pass authentication through" —
// no regions: http.md states the contract and links to the serving recipes
// (web-standard, express, hono, fastify) that build each mount. The harness
// below produces the `alice` result the auth section quotes.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// "Shape the response stream" — never invoked: `responseMode: 'json'` warns at
// construction by design, and the page quotes nothing from it.
// ---------------------------------------------------------------------------

/** Example: pin the response shape to plain JSON. */
function shapeResponse(factory: McpServerFactory) {
    //#region shapeResponse
    const jsonOnly = createMcpHandler(factory, { responseMode: 'json' });
    //#endregion shapeResponse
    return jsonOnly;
}
void shapeResponse;

// ---------------------------------------------------------------------------
// "Shut down" — never invoked: this program exits on its own.
// ---------------------------------------------------------------------------

/** Example: tear down in-flight modern exchanges on SIGINT. */
function shutDown(): void {
    //#region shutDown
    process.on('SIGINT', async () => {
        await handler.close();
        process.exit(0);
    });
    //#endregion shutDown
}
void shutDown;

// ---------------------------------------------------------------------------
// Harness (not shown on the page). A real `Client` drives each handler's
// `fetch` in process — the URL is never dialed (docs/testing.md owns that
// wiring). It produces the two tool results the page quotes verbatim.
// ---------------------------------------------------------------------------

const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');

// "Create a handler" — the add-note result the page quotes.
const client = new Client({ name: 'http-docs-harness', version: '1.0.0' });
await client.connect(
    new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
        fetch: (url, init) => handler.fetch(new Request(url, init))
    })
);
const saved = await client.callTool({ name: 'add-note', arguments: { text: 'ship the release notes' } });
console.log(saved.content);
await client.close();

// "Pass authentication through" — the caller hands `fetch` a verified
// `AuthInfo`; the factory above reads it back as `ctx.authInfo`.
const authInfo = { token: 'verified-elsewhere', clientId: 'alice', scopes: ['notes'] };
const alice = new Client({ name: 'http-docs-harness', version: '1.0.0' });
await alice.connect(
    new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
        fetch: (url, init) => perCaller.fetch(new Request(url, init), { authInfo })
    })
);
const who = await alice.callTool({ name: 'whoami' });
console.log(who.content);
await alice.close();

await handler.close();
await perCaller.close();
