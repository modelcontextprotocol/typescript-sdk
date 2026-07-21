---
shape: how-to
---

# Server Cards

::: warning
Server Cards are an experimental MCP extension ([SEP-2127](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2127)). The `experimental/server-card` subpaths may change or be removed in any release.
:::

A **Server Card** is a static JSON document describing a remote MCP server well enough to discover and connect to it before any protocol exchange. Cards are advisory: never use their contents for security or access-control decisions.

## Serve a card and a catalog

Build both documents at startup — an invalid card is a boot error, never a broken production document — and compose the responders in front of your MCP handler.

```ts source="../../examples/guides/advanced/server-cards.examples.ts#serve_card"
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
```

`serverCardResponse` answers `GET <mcp-path>/server-card` (the reserved location) and `aiCatalogResponse` answers `GET /.well-known/ai-catalog.json`, both with the spec's CORS headers, `Cache-Control: public, max-age=3600`, and a strong ETag that turns unchanged refetches into 304s. Unmatched paths return `undefined` synchronously and fall through to your own routing.

::: tip
Publish the catalog on the domain users associate with your service, which is not always the API host serving MCP traffic. `aiCatalogResponse` takes a `path` option when the well-known location is taken.
:::

## Serve from Express

An exact `app.all('/mcp', ...)` mount never sees `GET /mcp/server-card`. Mount the card router at the application root in front of it.

```ts source="../../examples/guides/advanced/server-cards.examples.ts#express_router"
// import { mcpServerCardRouter } from '@modelcontextprotocol/express/experimental/server-card';
const app = express();
app.use(mcpServerCardRouter({ card, mcpUrl, catalog: { catalog } }));
app.all('/mcp', mcpHandler); // the exact mount never sees GET /mcp/server-card; the router does
```

## Discover servers from a domain

`discoverServerCards` probes `https://{domain}/.well-known/ai-catalog.json`, follows the card entries, and returns validated cards with their listing chain. A domain without a catalog yields `[]`, a cacheable miss.

```ts source="../../examples/guides/advanced/server-cards.examples.ts#discover_domain"
const hits = await discoverServerCards('weather.example.com', discoveryOptions);
for (const hit of hits) {
    console.log(`${hit.entry.identifier}: listed by ${hit.listingDomain}, hosted by ${hit.hostingDomain}`);
}
```

Each hit names both sides of the listing chain for your consent UI:

```
urn:air:example.com:mcp:weather: listed by weather.example.com, hosted by weather.example.com
```

`listingDomain` is where the claim came from and `hostingDomain` is where traffic would go. Entries are self-asserted, so de-duplicate on `hit.card.remotes[].url`, never on names or catalog identifiers. Run the probe in the background, never auto-connect, and scope approval per server.

::: info
The fetchers reject private, loopback, and link-local addresses, cap response sizes, and bound redirects by default. These are hostname-level checks: inject a DNS-pinning `fetch` through the `fetch` option to defend against DNS rebinding, and pass `allowHttp`/`allowPrivateHosts` for local development.
:::

## Resolve inputs and connect

`requiredRemoteInputs` lists everything a card remote wants from the user (secrets, choices, defaults included). `resolveRemote` substitutes the `{var}` templates and hands you a URL and headers for the transport. After connecting, `reconcileServerCard` diffs the card's claims against the live `serverInfo`.

```ts source="../../examples/guides/advanced/server-cards.examples.ts#resolve_connect"
const remote = hits[0]!.card.remotes![0]!;
console.log(requiredRemoteInputs(remote)); // prompt the user for these; [] here
const { url, headers } = resolveRemote(remote);

const client = new Client({ name: 'discovery-host', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers }, fetch: inProcessFetch }));

const mismatches = reconcileServerCard(hits[0]!.card, client.getServerVersion()!, { remote });
console.log(mismatches); // runtime wins on any disagreement; [] means the card told the truth
```

The card above reconciles cleanly:

```
[]
```

A missing required input throws a `ServerCardError` with code `missing-input` carrying every unmet input, so one prompt round trip collects them all.

## Revalidate with the ETag

Fetch results return `etag` and `cacheControl` verbatim; you own the cache. Send the stored validator back and an unchanged document costs a 304.

```ts source="../../examples/guides/advanced/server-cards.examples.ts#etag_refetch"
const cardUrl = getServerCardUrl(mcpUrl);
const first = await fetchServerCard(cardUrl, discoveryOptions);
if (!first.notModified) {
    console.log(`cache ${first.url} etag=${first.etag !== undefined} cacheControl=${first.cacheControl}`);
}
const again = await fetchServerCard(cardUrl, { ...discoveryOptions, etag: first.etag });
console.log(again.notModified); // true: the document did not change
```

```
true
```

Cache per domain, including misses, and honor `Cache-Control` instead of polling.

## Recap

- `buildServerCard` and `buildAICatalog` validate at startup; `serverCardResponse` and `aiCatalogResponse` serve the documents with CORS, caching, and ETag handling from any web-standard host.
- `mcpServerCardRouter` serves both routes from Express, in front of an exact `/mcp` mount.
- `discoverServerCards` turns a domain into validated cards plus listing-chain provenance; a missing catalog is `[]`, not an error.
- `resolveRemote` and `requiredRemoteInputs` turn a card remote into a connectable URL and headers; `reconcileServerCard` diffs card claims against runtime, and runtime wins.
- Cards are advisory. De-duplicate on remote URLs, keep approval per server, and cache with the returned ETags.
