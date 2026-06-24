import type { ListToolsResult, Tool } from '@modelcontextprotocol/core';

/**
 * Client-side response cache for SEP-2549 (`CacheableResult`) freshness hints.
 *
 * The store is a dumb keyed-value carrier: every freshness, scope and
 * invalidation decision lives in the {@linkcode ClientResponseCache} (the
 * `Client`'s single cache-coordination collaborator). The `stamp` field is
 * mcp.d's re-derivation key — a derived view (e.g. the `name → Tool` index)
 * re-computes only when the backing entry's stamp changes.
 *
 * Reference design: mcp.d `client/cache.d` / `client/client.d` (`CacheStore`,
 * `cachedTool`, `cachedFetch`, `invalidateLogical`).
 */

/** A value or a promise of one. The store interface is async-ready; the in-memory default returns plain values. */
export type MaybePromise<T> = T | Promise<T>;

/** The freshness scope of a cached entry (SEP-2549 `cacheHints.scope`). */
export type CacheScope = 'public' | 'private';

/**
 * Per-call cache disposition for the cacheable verbs (`listTools()` /
 * `listPrompts()` / `listResources()` / `listResourceTemplates()` /
 * `readResource()`):
 *
 * - `'use'` (the default) — serve a still-fresh cached entry without a round
 *   trip; on miss/stale, fetch and write.
 * - `'refresh'` — always fetch (ignore any held entry) and write the fresh
 *   result.
 * - `'bypass'` — fetch without consulting OR writing the cache (the result is
 *   not stored). The `tools/list`-derived index (mirroring / output
 *   validation) is therefore unaffected by a `'bypass'` call.
 */
export type CacheMode = 'use' | 'refresh' | 'bypass';

/**
 * A logical cache address. `params` is the canonical result-affecting params
 * key (`''` for the four list ops, the `uri` for `resources/read`); omitted is
 * equivalent to `''`. `partition` namespaces the entry by connected-server
 * identity AND per-principal scope: the `Client` writes a JSON-encoded
 * `[serverIdentity, principal]` pair (so a server-controlled `serverInfo`
 * string cannot bleed into the principal slot regardless of what characters
 * it contains). A `'public'`-scoped entry lives at `[serverIdentity, '']`; a
 * `'private'`-scoped entry at `[serverIdentity, cachePartition]`. Omitted is
 * equivalent to `''`.
 */
export interface CacheKey {
    readonly method: string;
    readonly params?: string;
    readonly partition?: string;
}

/**
 * One cached response body. `value` is the verbatim decoded result; `stamp` is
 * the store-generated monotonically increasing write counter — opaque to
 * callers. Derived views (e.g. a `name → Tool` index) memoize against it and
 * re-derive only when it changes. `expiresAt` (absolute ms epoch, `now +
 * ttlMs`) and `scope` are the client-computed freshness metadata; the store
 * MUST persist them and hand them back on `get` so the read path can decide
 * freshness and gate the shared-partition fallback on `scope === 'public'`.
 */
export interface CacheEntry {
    readonly value: unknown;
    readonly stamp: number;
    readonly expiresAt?: number;
    readonly scope?: CacheScope;
}

/**
 * The pluggable response-cache store. The interface is intentionally narrow;
 * the in-memory default is the only implementation the SDK ships.
 *
 * Every method is async-ready ({@linkcode MaybePromise}) so a Redis-style
 * store can implement the same interface without a later breaking change; the
 * in-memory default stays synchronous (plain values are valid under
 * `MaybePromise`). The `Client` `await`s every call site.
 *
 * Entries are keyed by `{method, params, partition}` where `partition` is the
 * `Client`-derived `[serverIdentity, principal]` JSON pair, so one store
 * instance is safe to share across `Client` instances connected to different
 * servers and/or principals: writes from distinct connections never collide,
 * the shared-partition read fallback is gated on the stored
 * `scope === 'public'`, and `list_changed` / `HEADER_MISMATCH` evictions are
 * scoped to the connected server's two partitions — co-tenants on a shared
 * store are unaffected. The `Client` constructor still allocates a fresh
 * {@linkcode InMemoryResponseCacheStore} per instance by default; supply your
 * own to share or persist.
 */
export interface ResponseCacheStore {
    get(key: CacheKey): MaybePromise<CacheEntry | undefined>;
    /**
     * Writes `entry` under `key` and returns the store-generated stamp the
     * resulting {@linkcode CacheEntry} carries. The store owns the stamp
     * counter; callers do not supply one. The caller owns `expiresAt` and
     * `scope` (the client-computed freshness metadata); the store MUST persist
     * them and hand them back on `get`.
     */
    set(key: CacheKey, entry: { value: unknown; expiresAt?: number; scope?: CacheScope }): MaybePromise<number>;
    /**
     * Drop the single entry under `key` (no-op if absent). Called for both
     * `notifications/resources/updated` (per-URI) and the `list_changed`
     * notifications (the list singletons live at `{method, params: '', partition}`).
     */
    delete(key: CacheKey): MaybePromise<void>;
    /**
     * Drop every entry for `method` across every partition. The `Client` does
     * NOT call this (its `list_changed` path issues two partition-scoped
     * `delete()` calls so co-tenants on a shared store keep their entries);
     * kept on the interface for callers that want a method-wide bulk-clear.
     */
    evict(method: string): MaybePromise<void>;
    /** Drop every entry (connection reset). */
    clear(): MaybePromise<void>;
}

/** Options for {@linkcode InMemoryResponseCacheStore}. */
export interface InMemoryResponseCacheStoreOptions {
    /**
     * Maximum number of held `resources/read` entries (the only
     * unbounded-keyspace method). When inserting a new `resources/read` key
     * would exceed this, the oldest such entry (by insertion order) is
     * evicted first. The list-singleton methods (`tools/list`,
     * `prompts/list`, `resources/list`, `resources/templates/list`,
     * `server/discover`) are **exempt** — they hold at most one entry per
     * partition and back the `tools/list`-derived index, so an unbounded URI
     * working set never displaces them. The default of `512` bounds growth on
     * a long-lived client against template-expanded URIs. `0` disables the
     * bound.
     */
    maxEntries?: number;
}

/**
 * Methods whose entries are exempt from the
 * {@linkcode InMemoryResponseCacheStoreOptions.maxEntries} cap. Each holds at
 * most one entry per partition (a small bounded set) and the
 * `tools/list`-derived index depends on its entry surviving regardless of the
 * `resources/read` working-set size. Only `resources/read` keys count toward
 * the cap and are eligible for FIFO eviction.
 */
const CAP_EXEMPT_METHODS: ReadonlySet<string> = new Set([
    'tools/list',
    'prompts/list',
    'resources/list',
    'resources/templates/list',
    'server/discover'
]);

/**
 * In-memory default. Bounded by an insertion-ordered size cap (default `512`;
 * see {@linkcode InMemoryResponseCacheStoreOptions.maxEntries}) on the
 * `resources/read` keyspace so an unbounded stream of distinct URIs cannot
 * grow it without limit; the list-singleton methods are exempt and never
 * evicted by the cap. `Map` preserves insertion order, so the oldest live
 * capped key is the first matching iteration entry.
 */
export class InMemoryResponseCacheStore implements ResponseCacheStore {
    private readonly _entries = new Map<string, CacheEntry>();
    private readonly _maxEntries: number;
    private _stamp = 0;
    /** Count of held entries that are subject to the cap (i.e. not in {@linkcode CAP_EXEMPT_METHODS}). */
    private _cappedSize = 0;

    constructor(options?: InMemoryResponseCacheStoreOptions) {
        this._maxEntries = options?.maxEntries ?? 512;
    }

    /** Number of held entries (for diagnostics / bounding tests). */
    get size(): number {
        return this._entries.size;
    }

    get(key: CacheKey): CacheEntry | undefined {
        return this._entries.get(keyOf(key));
    }

    set(key: CacheKey, entry: { value: unknown; expiresAt?: number; scope?: CacheScope }): number {
        const k = keyOf(key);
        const exempt = CAP_EXEMPT_METHODS.has(key.method);
        const isNew = !this._entries.has(k);
        // Evict the oldest CAPPED entry first when adding a NEW capped key
        // would exceed the cap (re-set of an existing key never evicts; an
        // exempt-method write never evicts). `Map` iteration order is
        // insertion order, so the first non-exempt key is the oldest one.
        if (!exempt && isNew && this._maxEntries > 0 && this._cappedSize >= this._maxEntries) {
            for (const oldKey of this._entries.keys()) {
                if (!CAP_EXEMPT_METHODS.has(oldKey.slice(0, oldKey.indexOf('\0')))) {
                    this._entries.delete(oldKey);
                    this._cappedSize--;
                    break;
                }
            }
        }
        const stamp = ++this._stamp;
        this._entries.set(k, { ...entry, stamp });
        if (isNew && !exempt) this._cappedSize++;
        return stamp;
    }

    delete(key: CacheKey): void {
        if (this._entries.delete(keyOf(key)) && !CAP_EXEMPT_METHODS.has(key.method)) this._cappedSize--;
    }

    evict(method: string): void {
        const prefix = `${method}\0`;
        const exempt = CAP_EXEMPT_METHODS.has(method);
        for (const k of this._entries.keys()) {
            if (k.startsWith(prefix)) {
                this._entries.delete(k);
                if (!exempt) this._cappedSize--;
            }
        }
    }

    clear(): void {
        this._entries.clear();
        this._cappedSize = 0;
    }
}

/**
 * Serialize a {@linkcode CacheKey} for the in-memory map. `method` is always
 * an SDK-set MCP method string (never contains a NUL), so the `\0` prefix
 * delimiter is safe and lets {@linkcode InMemoryResponseCacheStore.evict} do a
 * cheap prefix scan. `partition` (already a JSON-encoded
 * `[serverIdentity, principal]` pair) and `params` (a resource URI on the
 * `resources/read` path — caller-controlled) are JSON-array-encoded together,
 * which is collision-free regardless of any NUL or delimiter characters they
 * carry.
 */
function keyOf(key: CacheKey): string {
    return `${key.method}\0${JSON.stringify([key.partition ?? '', key.params ?? ''])}`;
}

/**
 * Serialize a `{method, params}` pair for the eviction-generation map. The
 * list singletons key on `method` alone (their {@linkcode ClientResponseCache.evict}
 * is whole-method); `resources/read` keys on `` `${method}\0${uri}` `` so
 * {@linkcode ClientResponseCache.evictKey} bumps a per-URI counter.
 */
function genKey(method: string, params?: string): string {
    return params === undefined ? method : `${method}\0${params}`;
}

/**
 * Upper bound on the server-supplied `ttlMs` honoured by
 * {@linkcode ClientResponseCache} (24h). A server cannot pin an entry
 * indefinitely.
 */
export const MAX_CACHE_TTL_MS = 86_400_000;

/**
 * The `Client`'s cache-coordination collaborator.
 *
 * Owns the per-connection cache state that used to live as five private
 * fields on `Client` — the backing {@linkcode ResponseCacheStore}, the
 * per-method eviction-generation counter, the user-supplied/default flag, and
 * the stamp-memoized derived indices over the `tools/list` entry. `Client`
 * holds exactly one instance and never reaches past it to the store.
 *
 * Not exported from the package index — internal to the client package.
 *
 * @internal
 */
export class ClientResponseCache {
    /**
     * Per-logical-key eviction-generation counter. {@linkcode evict} (whole
     * method) and {@linkcode evictKey} (single `{method, params}`) bump it
     * before touching the store; {@linkcode captureGeneration} reads it before
     * the request; {@linkcode write} skips when it moved — so a `list_changed`
     * arriving mid-walk, or a `resources/updated` arriving while a
     * `readResource()` for the same URI is in flight, is not overwritten by
     * the in-flight request's stale write. The map key is `method` for the
     * list singletons and `` `${method}\0${params}` `` for per-URI keys.
     *
     * Growth is bounded by keys the CLIENT has issued a `captureGeneration`
     * for: {@linkcode captureGeneration} records the key (so an interleaved
     * {@linkcode evictKey} sees there is an in-flight write to suppress);
     * {@linkcode evictKey} only bumps a key that is already recorded — a
     * server streaming `notifications/resources/updated` for URIs the client
     * has never read therefore cannot grow this map.
     */
    private readonly _evictionGeneration = new Map<string, number>();
    /**
     * `name → Tool` index derived from the cached `tools/list` entry, memoized
     * against the entry's `stamp` so it re-derives only when the backing entry
     * changes (mcp.d's `cachedTool` pattern).
     */
    private _toolIndex?: { stamp: number; byName: Map<string, Tool> };
    /**
     * `name → compiled output-schema validator` derived from the cached
     * `tools/list` entry; same stamp-keyed memoization as `_toolIndex`. Typed
     * `unknown` so this class stays free of any validator-provider dependency
     * — the compile callback supplied to {@linkcode outputValidator} owns the
     * concrete type.
     */
    private _toolOutputValidatorIndex?: { stamp: number; byName: Map<string, unknown> };
    /**
     * The connected server's identity (`serverInfo.name@version`, or a
     * transport-supplied surrogate). Set by the `Client` immediately after a
     * successful connect; `''` is the pre-connect sentinel. Every storage
     * partition is derived from this (see `_partitionFor`), so two
     * clients sharing one store but connected to different servers never
     * collide on `tools/list` and a server cannot read another server's
     * `'public'` entries.
     */
    private _serverIdentity = '';

    constructor(
        private readonly _store: ResponseCacheStore,
        /**
         * Whether `_store` was supplied by the caller. A user-supplied store is
         * never `clear()`ed by {@linkcode resetForReconnect} (defeats the only
         * reason to supply one).
         */
        private readonly _isUserSupplied: boolean,
        /**
         * Sink for a custom store's `set()`/`evict()` failure. {@linkcode write}
         * never lets a store rejection cost the caller a result it already
         * fetched — the failure is reported here and the write resolves. The
         * `Client` wires this to `onerror`.
         */
        private readonly _reportError: (error: unknown) => void = () => {},
        /**
         * The opaque per-principal identifier for this client (the
         * `private`-scope storage slot within the connected server's
         * namespace). `''` (the default) makes the `private` slot identical to
         * the server's shared `public` slot — the safe single-tenant posture.
         * See `_partitionFor`.
         */
        private readonly _cachePartition: string = '',
        /**
         * Clock seam (testing). The freshness check (`entry.expiresAt > now()`)
         * and the `expiresAt = now() + ttlMs` stamp both read it via
         * {@linkcode now}. Default `Date.now`.
         */
        private readonly _now: () => number = Date.now
    ) {}

    /** The clock used for every freshness computation and check. */
    now(): number {
        return this._now();
    }

    /**
     * Record the connected server's identity. Called by `Client` immediately
     * after a successful connect (`serverInfo.name@version`, or the
     * transport's `sessionId` when `serverInfo` is unavailable). Every
     * partition derived after this call is scoped to this identity; entries
     * written under the pre-connect `''` sentinel are no longer reachable.
     */
    setServerIdentity(identity: string): void {
        this._serverIdentity = identity;
    }

    /**
     * Derive the storage partition for `scope`. The encoding is
     * `JSON.stringify([serverIdentity, principal])` — JSON escaping makes it
     * collision-free by construction: a malicious server cannot craft a
     * `serverInfo.name`/`version` whose concatenated form bleeds into another
     * server's namespace or another principal's slot, regardless of `@` / `|`
     * / `"` / NUL in the server-controlled strings. `'public'` →
     * `[serverIdentity, '']` (shared within this server); `'private'` →
     * `[serverIdentity, cachePartition]`. When `cachePartition` is `''` the
     * two coincide.
     */
    private _partitionFor(scope: CacheScope): string {
        return JSON.stringify([this._serverIdentity, scope === 'public' ? '' : this._cachePartition]);
    }

    /**
     * Two-probe lookup: this client's own (private) partition first, then the
     * connected server's shared (public) partition. The shared probe is gated
     * on `entry.scope === 'public'` — a co-tenant client that omits
     * `cachePartition` writes its `'private'`-scoped entries at the public
     * partition, and serving those to a correctly-partitioned client would
     * leak private bodies (mcp.d's `cachedEntry` two-probe order; the scope
     * gate is defence-in-depth on top of the partition split). When
     * `cachePartition` is `''` the two partitions are identical and only one
     * probe is issued.
     */
    private async _probe(method: string, params?: string): Promise<CacheEntry | undefined> {
        const key = { method, params: params ?? '' };
        const ownPartition = this._partitionFor('private');
        const own = await this._store.get({ ...key, partition: ownPartition });
        if (own !== undefined) return own;
        const sharedPartition = this._partitionFor('public');
        if (sharedPartition === ownPartition) return undefined;
        const shared = await this._store.get({ ...key, partition: sharedPartition });
        return shared?.scope === 'public' ? shared : undefined;
    }

    /**
     * Bump the per-method generation (so an in-flight {@linkcode write} for the
     * same method becomes a no-op) and drop the connected server's two list
     * singletons (own + shared partition; `params: ''`). The generation bump
     * is unconditional and FIRST — the {@linkcode write} race guard relies on
     * the bump, not on the store's deletes completing.
     *
     * Eviction is scoped to this client's `[serverIdentity, principal]`
     * partitions (mirroring {@linkcode evictKey}) — the method-wide
     * `store.evict()` is NOT called, so on a shared store one server's
     * `list_changed` cannot wipe a co-tenant's entry. A custom store's
     * `delete()` may throw or reject; each partition is guarded
     * independently so a failure on one does not skip the other, the failure
     * is reported via the constructor's sink, and the call resolves so
     * dispatch proceeds.
     */
    async evict(method: string): Promise<void> {
        this._evictionGeneration.set(method, (this._evictionGeneration.get(method) ?? 0) + 1);
        const ownPartition = this._partitionFor('private');
        const sharedPartition = this._partitionFor('public');
        try {
            await this._store.delete({ method, params: '', partition: ownPartition });
        } catch (error) {
            this._reportError(error);
        }
        if (sharedPartition !== ownPartition) {
            try {
                await this._store.delete({ method, params: '', partition: sharedPartition });
            } catch (error) {
                this._reportError(error);
            }
        }
    }

    /**
     * Drop the single logical entry `{method, params}` from BOTH the private
     * and public partitions for this client's connected server (mcp.d's
     * `invalidateLogical`). Used for `notifications/resources/updated`'s
     * per-URI eviction. The per-key generation is bumped FIRST (so an
     * in-flight {@linkcode write} for the same `{method, params}` becomes a
     * no-op and cannot re-cache the now-stale body) but only when the key was
     * already recorded by {@linkcode captureGeneration} — bounding the map to
     * keys the client has actually read. A custom store's `delete()` may
     * throw or reject; each partition's delete is guarded independently so a
     * failure on one does not skip the other, and the call resolves so
     * dispatch proceeds.
     */
    async evictKey(method: string, params: string): Promise<void> {
        const gk = genKey(method, params);
        // Only bump a key the client has actually captured: if no entry is
        // present there is no in-flight write to suppress, and an
        // unconditional bump would let a server streaming distinct-URI
        // `resources/updated` notifications grow this map without bound. The
        // store deletes still run regardless (a previously-written entry may
        // be held even when the generation entry has since been cleared by
        // `resetForReconnect`).
        const current = this._evictionGeneration.get(gk);
        if (current !== undefined) this._evictionGeneration.set(gk, current + 1);
        const ownPartition = this._partitionFor('private');
        const sharedPartition = this._partitionFor('public');
        try {
            await this._store.delete({ method, params, partition: ownPartition });
        } catch (error) {
            this._reportError(error);
        }
        if (sharedPartition !== ownPartition) {
            try {
                await this._store.delete({ method, params, partition: sharedPartition });
            } catch (error) {
                this._reportError(error);
            }
        }
    }

    /**
     * Snapshot the eviction generation for `{method, params}` before issuing
     * the request (a list walk's page 1, or a `resources/read` for `params`).
     * Records the key so an interleaved {@linkcode evictKey} for the same
     * `{method, params}` knows there is an in-flight write to suppress and
     * bumps; without the record, `evictKey`'s recorded-only bump would skip
     * and the stale body would be cached.
     */
    captureGeneration(method: string, params?: string): number {
        const gk = genKey(method, params);
        const current = this._evictionGeneration.get(gk) ?? 0;
        this._evictionGeneration.set(gk, current);
        return current;
    }

    /**
     * Write `value` under `{method}` unless the per-method generation moved
     * since `capturedGen` was taken — a `list_changed` that landed mid-walk has
     * already invalidated the result the caller is about to write, and
     * overwriting the eviction with the stale aggregate would lose the
     * invalidation.
     *
     * The stored value is a `structuredClone` of `value`, so a caller
     * mutating the aggregate it was returned (e.g. `result.tools.sort(...)`)
     * cannot reach the cache or the stamp-memoized indices derived from it. A
     * custom store whose `set()` throws or rejects is routed to the
     * `reportError` sink and the write resolves — cache bookkeeping never
     * costs the caller a result it already fetched (consistent with the
     * eviction path).
     *
     * `freshness` carries the client-computed `expiresAt` (absolute ms epoch,
     * `now + ttlMs`) and the server-reported `cacheScope`. The storage
     * `partition` is derived from the scope via `_partitionFor`:
     * `'public'` → `[serverIdentity, '']` (shared within this server);
     * `'private'` → `[serverIdentity, cachePartition]` (so a shared store
     * never serves a private entry to another identity). Absent `freshness`
     * preserves the substrate write (no `expiresAt`, private partition) — the
     * `tools/list` retain-for-schema posture: never served by
     * {@linkcode read}'s freshness gate, always readable by
     * {@linkcode toolDefinition}.
     *
     * After storing under the derived partition, the same `{method, params}`
     * is deleted from the OPPOSITE partition (mirroring {@linkcode evictKey}'s
     * two-partition posture). A server that flips a result's `cacheScope` for
     * the same key would otherwise leave the previous entry in the other slot
     * — and since `_probe` checks own-partition first, a stale private entry
     * would shadow the fresh public one (or a stale public entry would keep
     * serving co-tenants). Both store calls are independently guarded so a
     * custom store's failure on one does not skip the other.
     */
    async write(
        method: string,
        value: unknown,
        capturedGen: number,
        freshness?: { expiresAt: number; scope: CacheScope; params?: string }
    ): Promise<void> {
        if ((this._evictionGeneration.get(genKey(method, freshness?.params)) ?? 0) !== capturedGen) return;
        const params = freshness?.params ?? '';
        const ownPartition = this._partitionFor('private');
        const sharedPartition = this._partitionFor('public');
        const partition = (freshness?.scope ?? 'private') === 'public' ? sharedPartition : ownPartition;
        try {
            await this._store.set(
                { method, params, partition },
                { value: structuredClone(value), expiresAt: freshness?.expiresAt, scope: freshness?.scope }
            );
        } catch (error) {
            this._reportError(error);
        }
        if (sharedPartition !== ownPartition) {
            try {
                await this._store.delete({
                    method,
                    params,
                    partition: partition === ownPartition ? sharedPartition : ownPartition
                });
            } catch (error) {
                this._reportError(error);
            }
        }
    }

    /**
     * Read the cached entry for `{method, params}` via the two-probe lookup
     * (own-partition then this server's shared partition, gated on
     * `scope === 'public'`). The caller owns the freshness check
     * (`entry.expiresAt > now()`); a missing `expiresAt` is never fresh.
     */
    async read(method: string, params?: string): Promise<CacheEntry | undefined> {
        return this._probe(method, params);
    }

    /**
     * Connection reset. The per-instance default store IS cleared
     * (connection-scoped); a user-supplied store is NOT — that would defeat
     * the only reason to supply one. The generation map and every derived
     * index are dropped regardless: they are connection-scoped even when the
     * backing store survives, so the next read re-derives from whatever the
     * store still holds. The server identity returns to the pre-connect
     * sentinel. The default impl is synchronous, so the `MaybePromise<void>`
     * return is a plain void here and the caller need not await.
     */
    resetForReconnect(): void {
        if (!this._isUserSupplied) void this._store.clear();
        this._evictionGeneration.clear();
        this._toolIndex = undefined;
        this._toolOutputValidatorIndex = undefined;
        this._serverIdentity = '';
    }

    /**
     * The descriptor for tool `name` taken from the cached `tools/list` entry.
     * The `name → Tool` index is memoized against the entry's `stamp` and
     * re-derived only when the backing entry changes (mcp.d's `cachedTool`).
     * Returns `undefined` only when no `tools/list` response is held at all,
     * or the held list does not contain `name`.
     *
     * Consumed by `callTool()`'s SEP-2243 `_resolveXMcpHeaderScan` (mirroring)
     * and, via {@linkcode outputValidator}, its output-schema validation.
     */
    async toolDefinition(name: string): Promise<Tool | undefined> {
        const entry = await this._probe('tools/list');
        if (entry === undefined) {
            this._toolIndex = undefined;
            return undefined;
        }
        if (this._toolIndex?.stamp !== entry.stamp) {
            const byName = new Map<string, Tool>();
            for (const tool of (entry.value as ListToolsResult).tools) byName.set(tool.name, tool);
            this._toolIndex = { stamp: entry.stamp, byName };
        }
        return this._toolIndex.byName.get(name);
    }

    /**
     * The compiled output-schema validator for tool `name`, derived from the
     * cached `tools/list` entry — same source and same stamp-keyed
     * memoization as {@linkcode toolDefinition}. The `name → validator` index
     * re-derives only when the backing entry's stamp changes (a refetched
     * `tools/list` recompiles; a `list_changed` eviction drops it). Returns
     * `undefined` when no `tools/list` is held, the tool is absent, or it has
     * no `outputSchema`.
     *
     * `compile` is the caller-supplied validator-compile callback (the
     * `Client` passes its `_jsonSchemaValidator` wrapper) so this
     * class carries no validator-provider dependency. One tool's uncompilable
     * `outputSchema` (e.g. an invalid `pattern` regex or unresolvable `$ref`)
     * must not poison every other tool's `callTool` — the callback isolates
     * that compile error per tool by returning a per-tool error variant which
     * the index stores alongside the good ones, and `callTool` surfaces it as
     * a typed `InvalidParams` only for that name. Because the error is held on
     * this stamp-keyed substrate (not a parallel map), it inherits the
     * substrate's invalidation lifecycle: a `list_changed` eviction drops it,
     * a refetched `tools/list` re-derives it, and `resetForReconnect` clears
     * the lot.
     */
    async outputValidator<V>(name: string, compile: (tool: Tool) => V | undefined): Promise<V | undefined> {
        const entry = await this._probe('tools/list');
        if (entry === undefined) {
            this._toolOutputValidatorIndex = undefined;
            return undefined;
        }
        if (this._toolOutputValidatorIndex?.stamp !== entry.stamp) {
            const byName = new Map<string, unknown>();
            for (const tool of (entry.value as ListToolsResult).tools) {
                const compiled = compile(tool);
                if (compiled !== undefined) byName.set(tool.name, compiled);
            }
            this._toolOutputValidatorIndex = { stamp: entry.stamp, byName };
        }
        return this._toolOutputValidatorIndex.byName.get(name) as V | undefined;
    }
}
