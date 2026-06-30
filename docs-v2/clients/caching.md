---
status: scaffold
shape: how-to
---
# Cache responses

<!-- SCAFFOLD - structure only; prose comes in a later tranche.
scope: Client store + server cache hints, presented as one feature.
teaches: CacheableRequestOptions.cacheMode, ClientOptions.responseCacheStore, ClientOptions.cachePartition, ClientOptions.defaultCacheTtlMs, InMemoryResponseCacheStore, MAX_CACHE_TTL_MS, server-side ttlMs/cacheScope hints (SEP-2549)
source: mined from docs/client.md "Response caching (2026-07-28 draft)"; server hint side mined from docs/server.md / packages/server/src — ONE feature, both halves on this page
-->

## Let the cache work

<!-- teaches: the zero-config path — cacheable verbs honour the server's ttlMs automatically; cacheMode overrides per call | salvage: docs/client.md "Response caching (2026-07-28 draft)" -->

```ts
// draft - API verified against packages/client/src/client/client.ts (listTools(params?, options?: CacheableRequestOptions), readResource) and packages/client/src/client/responseCache.ts (InMemoryResponseCacheStore, MAX_CACHE_TTL_MS)
const tools = await client.listTools(); // network, then cached for the server's ttlMs
const again = await client.listTools(); // served from cache while still fresh

await client.listTools(undefined, { cacheMode: 'refresh' }); // always refetch and re-store
await client.readResource({ uri: 'config://app' }, { cacheMode: 'bypass' }); // no cache read or write
```

<!-- result: the second listTools() makes no network round trip; quote the companion example's timing/log output. -->

## Have the server send the hint

<!-- teaches: the other half of the feature — the server attaches ttlMs / cacheScope to cacheable results (SEP-2549); without a hint nothing is served from cache | salvage: net-new (server cache-hint config in packages/server/src); cross-reference, not duplicated prose -->
<!-- code: the server-side registration option that sets ttlMs / cacheScope on a list result -->

## Choose a cache mode per call

<!-- teaches: cacheMode 'refresh' vs 'bypass' vs default; which verbs are cacheable (tools/list, prompts/list, resources/list, resources/templates/list, resources/read, server/discover) | salvage: docs/client.md "Response caching" -->
<!-- code: none — placeholder comment naming the three modes; 'bypass' leaves the cache byte-untouched -->

## Bring your own store

<!-- teaches: ClientOptions.responseCacheStore, the ResponseCacheStore interface, InMemoryResponseCacheStore default | salvage: docs/client.md "Response caching" (ClientOptions bullets) -->
<!-- code: new Client(info, { responseCacheStore: myStore }) -->

## Partition the store per user

<!-- teaches: ClientOptions.cachePartition isolating 'private'-scoped entries when one store serves several principals | salvage: docs/client.md "Response caching" (IMPORTANT callout) -->
<!-- code: new Client(info, { responseCacheStore: shared, cachePartition: userId }) -->
<!-- aside: ::: warning — a shared store without cachePartition can serve one user's private resource bodies to another -->

## Cache against servers that send no hints

<!-- teaches: ClientOptions.defaultCacheTtlMs; eviction on list_changed / resources/updated notifications | salvage: docs/client.md "Response caching" (defaultCacheTtlMs bullet + eviction paragraph) -->
<!-- code: new Client(info, { defaultCacheTtlMs: 60_000 }) -->
<!-- aside: ::: info — one-line era cross-link to /protocol-versions: cache hints are a 2026-07-28 surface; against 2025-era servers defaultCacheTtlMs is the only lever -->

## Recap

<!-- the claims this page will prove:
- Caching is one feature with two halves: the server sends ttlMs/cacheScope, the client honours it — neither half does anything alone (by default).
- The cacheable verbs serve a still-fresh result without a round trip; cacheMode overrides per call.
- responseCacheStore swaps the backing store; cachePartition is mandatory when that store is shared across principals.
- defaultCacheTtlMs is the opt-in for servers that send no hints.
- list_changed and resources/updated notifications evict automatically.
-->
