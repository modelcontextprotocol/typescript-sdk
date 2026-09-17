/**
 * Companion example for `docs/advanced/custom-methods.md`.
 *
 * Every `ts` fence on that page is synced from a `//#region` in this file
 * (`pnpm sync:snippets --check`). The file also runs: the harness below the
 * regions connects an in-memory client and produces the output the page quotes
 * verbatim.
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *     npx tsx guides/advanced/custom-methods.examples.ts        # from examples/
 *
 * @module
 */
/* eslint-disable no-console */
//#region setRequestHandler_custom
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const SearchParams = z.object({ query: z.string(), limit: z.number().int().default(10) });
const SearchResult = z.object({ items: z.array(z.string()) });

const mcp = new McpServer({ name: 'acme-search', version: '1.0.0' });

mcp.server.setRequestHandler('acme/search', { params: SearchParams, result: SearchResult }, async ({ query, limit }) => {
    return { items: Array.from({ length: limit }, (_, index) => `${query}-${index}`) };
});
//#endregion setRequestHandler_custom

// "Declare an extension capability" — must happen before the server connects.
//#region registerCapabilities_extensions
mcp.server.registerCapabilities({
    extensions: { 'com.example/feature-flags': { flags: ['dark-mode', 'beta-search'] } }
});
//#endregion registerCapabilities_extensions

// ---------------------------------------------------------------------------
// Harness (not shown on the page). An in-memory client drives the calls whose
// output advanced/custom-methods.md quotes verbatim. Any MCP client behaves
// the same. Imported dynamically so the page's lead region stays self-contained.
// ---------------------------------------------------------------------------

const { Client, InMemoryTransport } = await import('@modelcontextprotocol/client');

const client = new Client({ name: 'custom-methods-docs-harness', version: '1.0.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await mcp.connect(serverTransport);
await client.connect(clientTransport);

// "Call it from the client" — the result the page quotes.
//#region request_custom
const result = await client.request({ method: 'acme/search', params: { query: 'mcp', limit: 3 } }, SearchResult);
console.log(result);
//#endregion request_custom

// Proof for the page's ::: tip — params that fail `SearchParams` are rejected
// before the handler runs. Throws (non-zero exit) if the claim is false.
let rejection: Error | undefined;
try {
    await client.request({ method: 'acme/search', params: { query: 42 } }, SearchResult);
} catch (error) {
    rejection = error as Error;
}
if (!rejection) {
    throw new Error('custom-methods.md tip claim failed: invalid params were accepted');
}
console.log(rejection.message);

// "Read the negotiated extensions on the client" — the map the page quotes.
//#region getServerCapabilities_extensions
const extensions = client.getServerCapabilities()?.extensions ?? {};
console.log(extensions);
//#endregion getServerCapabilities_extensions

// "Send a custom notification from the handler" — registering the method again
// replaces its handler with one that reports progress.
//#region setRequestHandler_notify
mcp.server.setRequestHandler('acme/search', { params: SearchParams, result: SearchResult }, async ({ query, limit }, ctx) => {
    await ctx.mcpReq.notify({ method: 'acme/searchProgress', params: { stage: 'start', pct: 0 } });
    const items = Array.from({ length: limit }, (_, index) => `${query}-${index}`);
    await ctx.mcpReq.notify({ method: 'acme/searchProgress', params: { stage: 'done', pct: 1 } });
    return { items };
});
//#endregion setRequestHandler_notify

// "Receive it on the client" — the progress params the page quotes.
//#region setNotificationHandler_custom
const SearchProgressParams = z.object({ stage: z.string(), pct: z.number() });

client.setNotificationHandler('acme/searchProgress', { params: SearchProgressParams }, params => {
    console.log(params);
});

await client.request({ method: 'acme/search', params: { query: 'mcp', limit: 1 } }, SearchResult);
//#endregion setNotificationHandler_custom

// Let the notification microtasks drain before tearing the pair down.
await new Promise(resolve => setImmediate(resolve));

await client.close();
await mcp.close();
