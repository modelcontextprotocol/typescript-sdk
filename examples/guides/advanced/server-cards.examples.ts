/**
 * Companion example for `docs/advanced/server-cards.md`.
 *
 * Every `ts` fence on that page is synced from a `//#region` in this file
 * (`pnpm sync:snippets --check`). The file also runs: the harness drives the
 * composed fetch handler in process (a FetchLike that dispatches straight to
 * it), discovers the card, connects, and produces the output the page quotes
 * verbatim.
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *     npx tsx guides/advanced/server-cards.examples.ts        # from examples/
 *
 * @module
 */
/* eslint-disable no-console */
import { check } from '@mcp-examples/shared';
import { mcpServerCardRouter } from '@modelcontextprotocol/express/experimental/server-card';
import express from 'express';

//#region serve_card
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import {
    aiCatalogResponse,
    buildAICatalog,
    buildServerCard,
    getServerCardUrl,
    serverCardCatalogEntry,
    serverCardResponse
} from '@modelcontextprotocol/server/experimental/server-card';

const serverInfo = { name: 'com.example/weather', version: '1.0.0' };
const mcpUrl = new URL('https://weather.example.com/mcp');

const card = buildServerCard({
    name: 'com.example/weather',
    description: 'Hourly and 7-day forecasts for any coordinates',
    serverInfo, // prefills version, title, websiteUrl, icons
    remotes: [{ type: 'streamable-http', url: mcpUrl.href }]
});
const catalog = buildAICatalog({
    entries: [serverCardCatalogEntry(card, { url: getServerCardUrl(mcpUrl) })]
});

const handler = createMcpHandler(() => new McpServer(serverInfo));

async function fetchHandler(request: Request): Promise<Response> {
    return await (serverCardResponse(request, { card, mcpUrl }) ?? aiCatalogResponse(request, { catalog }) ?? handler.fetch(request));
}
//#endregion serve_card

// ---------------------------------------------------------------------------
// Harness plumbing (not shown on the page): a FetchLike that dispatches to the
// handler above in process, so discovery and the MCP connection run without
// binding a port.
// ---------------------------------------------------------------------------

const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
const { discoverServerCards, fetchServerCard, requiredRemoteInputs, resolveRemote, reconcileServerCard } = await import(
    '@modelcontextprotocol/client/experimental/server-card'
);
const inProcessFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => fetchHandler(new Request(url, init));
const discoveryOptions = { fetch: inProcessFetch };

// "Discover servers from a domain" — the hit the page quotes.
//#region discover_domain
const hits = await discoverServerCards('weather.example.com', discoveryOptions);
for (const hit of hits) {
    console.log(`${hit.entry.identifier}: listed by ${hit.listingDomain}, hosted by ${hit.hostingDomain}`);
}
//#endregion discover_domain
check(hits.length === 1, 'one card discovered');
check(hits[0]!.listingDomain === 'weather.example.com' && hits[0]!.hostingDomain === 'weather.example.com', 'provenance');

// "Resolve inputs and connect".
//#region resolve_connect
const remote = hits[0]!.card.remotes![0]!;
console.log(requiredRemoteInputs(remote)); // prompt the user for these; [] here
const { url, headers } = resolveRemote(remote);

const client = new Client({ name: 'discovery-host', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers }, fetch: inProcessFetch }));

const mismatches = reconcileServerCard(hits[0]!.card, client.getServerVersion()!, { remote });
console.log(mismatches); // runtime wins on any disagreement; [] means the card told the truth
//#endregion resolve_connect
check(url.href === 'https://weather.example.com/mcp', 'resolved url');
check(mismatches.length === 0, 'card reconciles cleanly');

// "Revalidate with the ETag" — caller-owned caching.
//#region etag_refetch
const cardUrl = getServerCardUrl(mcpUrl);
const first = await fetchServerCard(cardUrl, discoveryOptions);
if (!first.notModified) {
    console.log(`cache ${first.url} etag=${first.etag !== undefined} cacheControl=${first.cacheControl}`);
}
const again = await fetchServerCard(cardUrl, { ...discoveryOptions, etag: first.etag });
console.log(again.notModified); // true: the document did not change
//#endregion etag_refetch
check(again.notModified, '304 on revalidation');

await client.close();
await handler.close();

// The express adapter (shown on the page, never started here): mount the card
// router in front of an exact /mcp mount.
export function expressWiring(mcpHandler: (req: unknown, res: unknown) => void) {
    //#region express_router
    // import { mcpServerCardRouter } from '@modelcontextprotocol/express/experimental/server-card';
    const app = express();
    app.use(mcpServerCardRouter({ card, mcpUrl, catalog: { catalog } }));
    app.all('/mcp', mcpHandler); // the exact mount never sees GET /mcp/server-card; the router does
    //#endregion express_router
    return app;
}
