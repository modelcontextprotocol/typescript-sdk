---
shape: how-to
---
# Cache responses

Caching is one feature with two halves: the server marks a result with a freshness hint, and the client's **response cache** serves it locally while it stays fresh.

## Let the cache work

The cacheable verbs check the cache before they send. A still-fresh entry comes back without a round trip; `cacheMode` overrides the disposition per call.

```ts source="../../examples/guides/clients/caching.examples.ts#responseCache_use"
const tools = await client.listTools(); // network, then cached for the server's ttlMs
const again = await client.listTools(); // served from cache while still fresh

await client.listTools(undefined, { cacheMode: 'refresh' }); // always refetch and re-store
await client.readResource({ uri: 'config://app' }, { cacheMode: 'bypass' }); // no cache read or write
```

`client` is connected to the server in the next section — served in-process by `createMcpHandler`, the wiring [Test a server](../testing.md) shows — and the harness counts every request that reaches it. After all four calls, only the first `listTools()` and the `'refresh'` crossed the wire:

```
tools/list requests that reached the server: 2
resources/read requests that reached the server: 1
```

Nothing on the client opts in: every `Client` holds a response cache, and the server's hint decides what it may serve.

## Have the server send the hint

`ServerOptions.cacheHints` attaches a `ttlMs` and a `cacheScope` to each cacheable result it names (SEP-2549) — without one, the SDK emits `ttlMs: 0` and no client ever serves that result from cache.

```ts source="../../examples/guides/clients/caching.examples.ts#cacheHints_server"
const server = new McpServer(
    { name: 'catalog', version: '1.0.0' },
    {
        cacheHints: {
            'tools/list': { ttlMs: 60_000, cacheScope: 'public' },
            'resources/read': { ttlMs: 5_000, cacheScope: 'private' }
        }
    }
);
```

`registerResource` also takes a per-resource `cacheHint`; it wins, field by field, over the `resources/read` entry here for that resource's read results. Mark a result `cacheScope: 'public'` only when it is identical for every caller — anything derived from the caller's authorization context stays `'private'`, the default.

::: tip
A server cannot pin an entry forever: the client caps any `ttlMs` at 24 hours (`MAX_CACHE_TTL_MS`).
:::

## Choose a cache mode per call

`cacheMode` on `listTools()`, `listPrompts()`, `listResources()`, `listResourceTemplates()`, and `readResource()` — the cacheable verbs — takes one of three values. `'use'`, the default, serves a still-fresh entry and otherwise fetches and stores. `'refresh'` always fetches and stores the fresh result.

`'bypass'` fetches without reading or writing: it leaves the cache byte-untouched, including the `tools/list` entry the SDK itself reads for output validation when you [call tools](./calling.md).

## Bring your own store

`responseCacheStore` swaps the backing store; the default is a fresh `InMemoryResponseCacheStore` per client, holding at most 512 `resources/read` entries.

```ts source="../../examples/guides/clients/caching.examples.ts#responseCacheStore_shared"
const store = new InMemoryResponseCacheStore({ maxEntries: 2048 });

const client = new Client({ name: 'my-client', version: '1.0.0' }, { responseCacheStore: store });
```

Every method on the `ResponseCacheStore` interface may return a promise, so a Redis-style store implements the same five methods. Entries are keyed by connected-server identity, so one store can back many clients: connections to different servers never collide.

## Partition the store per user

When one shared store serves several principals, set `cachePartition` to a stable identity of the authorization context — the auth subject, for example.

```ts source="../../examples/guides/clients/caching.examples.ts#cachePartition_perUser"
const client = new Client({ name: 'gateway', version: '1.0.0' }, { responseCacheStore: sharedStore, cachePartition: userId });
```

`'private'`-scoped entries are stored under that partition and never read across it; `'public'`-scoped entries stay shared within the server's namespace.

::: warning
A shared store without `cachePartition` can serve one user's `'private'`-scoped resource bodies to another. Set it whenever the store outlives a single principal.
:::

## Cache against servers that send no hints

`defaultCacheTtlMs` is the TTL applied when a cacheable result arrives without a `ttlMs`. The default is `0`: a result with no hint is never served from cache.

```ts source="../../examples/guides/clients/caching.examples.ts#defaultCacheTtlMs_optIn"
const client = new Client({ name: 'my-client', version: '1.0.0' }, { defaultCacheTtlMs: 60_000 });
```

Fresh or not, the cache also evicts itself when the server signals a change: a `list_changed` notification drops the matching list entries, and `notifications/resources/updated` drops the cached body for that URI — see [Subscriptions](./subscriptions.md).

::: info
Cache hints are a 2026-07-28 surface — see [Protocol versions](../protocol-versions.md). Against a 2025-era server, `defaultCacheTtlMs` is the only lever.
:::

## Recap

- Caching is one feature with two halves: the server attaches `ttlMs` / `cacheScope`, the client honours them — by default neither half does anything alone.
- `listTools()`, `listPrompts()`, `listResources()`, `listResourceTemplates()`, and `readResource()` serve a still-fresh result without a round trip; `cacheMode` overrides per call.
- A result without a hint carries `ttlMs: 0` and is never served from cache; the client caps every `ttlMs` at 24 hours.
- `responseCacheStore` swaps the backing store; `cachePartition` is mandatory when that store serves several principals.
- `defaultCacheTtlMs` opts in to caching against servers that send no hints.
- `list_changed` and `notifications/resources/updated` evict matching entries automatically.
