# caching

`CacheableResult` freshness hints (protocol revision 2026-07-28). The server declares hints at two layers — a per-registration `cacheHint` on the resource and server-level `ServerOptions.cacheHints` — and the SDK resolves most-specific-author-first (handler-return fields would
take precedence over both) and stamps `ttlMs`/`cacheScope` on the wire toward modern clients only. The client honours the stamped values: a still-fresh held entry is served without a round trip.

```bash
pnpm tsx examples/caching/client.ts
```

The client calls `listTools()` and `readResource()` twice each; the second of each pair is served from the response cache. The server exposes a `request-count` tool (how many `tools/list` requests reached it) and a `read-count` tool (how many times the resource handler ran), so the example asserts each counter is unchanged after the cache-served call and increments after `cacheMode: 'refresh'`.

## `cacheMode`

Per-call control on the cacheable verbs (`listTools()` / `listPrompts()` / `listResources()` / `listResourceTemplates()` / `readResource()`):

```ts
await client.readResource({ uri: 'config://app' }); // 'use' (default): serve from cache if fresh
await client.readResource({ uri: 'config://app' }, { cacheMode: 'refresh' }); // always fetch, then re-store
await client.readResource({ uri: 'config://app' }, { cacheMode: 'bypass' }); // fetch; do not read or write the cache
```

A `list_changed` notification still evicts immediately regardless of TTL.

## Custom store

The default per-client `InMemoryResponseCacheStore` (bounded at 512 entries by default) is enough for most hosts. To back the cache with something persistent (Redis, KV, IndexedDB), implement the five-method `ResponseCacheStore` interface — the store is a dumb keyed-value carrier; freshness and partitioning are the client's job:

```ts
import type { CacheEntry, CacheKey, CacheScope, ResponseCacheStore } from '@modelcontextprotocol/client';

class MyStore implements ResponseCacheStore {
    async get(key: CacheKey): Promise<CacheEntry | undefined> {
        /* read {value, stamp, expiresAt, scope} from your backend */
    }
    async set(key: CacheKey, entry: { value: unknown; expiresAt?: number; scope?: CacheScope }): Promise<number> {
        /* write entry under key; return a monotonically-increasing stamp */
    }
    async delete(key: CacheKey): Promise<void> {
        /* drop the single entry under key (no-op if absent) */
    }
    async evict(method: string): Promise<void> {
        /* drop every entry whose key.method === method (across every partition) */
    }
    async clear(): Promise<void> {
        /* drop everything */
    }
}

const client = new Client({ name: 'host', version: '1.0.0' }, { responseCacheStore: new MyStore(), cachePartition: principalId });
```

The SDK scopes every entry by the connected server's identity automatically — you do not encode server identity into `cachePartition` or the store key yourself. When one store backs several principals against the same server, set `ClientOptions.cachePartition` to a stable identity of the authorization context (e.g. the auth subject) so `'private'`-scoped entries are isolated per principal; `'public'`-scoped entries are shared within the connected server's namespace automatically. Note `serverInfo` is self-reported, so a server that deliberately impersonates another's `name`/`version` shares its `'public'` slot; the per-principal isolation holds regardless.
