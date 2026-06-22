import type { ListToolsResult, Tool } from '@modelcontextprotocol/core';

/**
 * Minimal response-cache substrate (the kernel of #39's design).
 *
 * The store is a dumb keyed-value carrier: every freshness, scope and
 * invalidation decision lives in the {@linkcode ClientResponseCache} (the
 * `Client`'s single cache-coordination collaborator). This file
 * deliberately
 * ships only what the SEP-2243 mirroring path and the existing
 * `tools/list`-derived validators need today — the full `cacheHints` engine
 * (TTL short-circuiting, public/private partitioning, `CacheMode`) lands with
 * the rest of #39 on top of the same interface.
 *
 * Reference design: mcp.d `client/cache.d` / `client/client.d` (`CacheStore`,
 * `cachedTool`). The `stamp` field is mcp.d's re-derivation key — a derived
 * view (e.g. the `name → Tool` index) re-computes only when the backing
 * entry's stamp changes.
 */

/** A value or a promise of one. The store interface is async-ready; the in-memory default returns plain values. */
export type MaybePromise<T> = T | Promise<T>;

/** The freshness scope of a cached entry (#39's `cacheHints.scope`). */
export type CacheScope = 'public' | 'private';

/**
 * A logical cache address. `params` is the canonical result-affecting params
 * key (`''` for the four list ops, the `uri` for `resources/read`); omitted is
 * equivalent to `''`. `partition` is the per-principal identity slot reserved
 * for #39's shared-store partitioning — always `''` today (the
 * `Client` never populates it); omitted is equivalent to `''`.
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
 * re-derive only when it changes. `expiresAt` and `scope` are the
 * client-computed freshness metadata (#39 — `expiresAt = now + ttlMs`,
 * `scope` from `cacheHints`); the substrate does not populate them yet, but
 * the slot exists so a custom store written today persists them once #39
 * lands without a signature change.
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
 * **A store instance MUST NOT be shared across `Client` instances at
 * all in v2.0.x.** Entries are keyed by method + params only (the
 * `Client` never populates `partition` today), so two clients
 * connected to different servers — even under the same credential — collide on
 * `tools/list` (server-identity confusion); a `list_changed` from one server
 * evicts every co-tenant's entry; and one client reconnecting drops the
 * derived indices that read the shared store. The `Client`
 * constructor always allocates a fresh {@linkcode InMemoryResponseCacheStore}
 * when `responseCacheStore` is not supplied; pass your own only as a
 * single-client backing store. Per-principal partitioning that enables safe
 * sharing arrives with the full #39 `cacheHints` engine.
 */
export interface ResponseCacheStore {
    get(key: CacheKey): MaybePromise<CacheEntry | undefined>;
    /**
     * Writes `entry` under `key` and returns the store-generated stamp the
     * resulting {@linkcode CacheEntry} carries. The store owns the stamp
     * counter; callers do not supply one. The caller owns `expiresAt` and
     * `scope` (the client-computed freshness metadata; not yet populated by
     * the substrate — #39 wires them); the store MUST persist them and hand
     * them back on `get`.
     */
    set(key: CacheKey, entry: { value: unknown; expiresAt?: number; scope?: CacheScope }): MaybePromise<number>;
    /** Drop every entry for `method` (the `list_changed` invalidation). */
    evict(method: string): MaybePromise<void>;
    /** Drop every entry (connection reset). */
    clear(): MaybePromise<void>;
}

/**
 * In-memory default. Unbounded — the four list ops write at most one entry
 * each, so a bound is not yet useful; the LRU cap arrives with `resources/read`
 * caching in #39.
 */
export class InMemoryResponseCacheStore implements ResponseCacheStore {
    private readonly _entries = new Map<string, CacheEntry>();
    private _stamp = 0;

    get(key: CacheKey): CacheEntry | undefined {
        return this._entries.get(keyOf(key));
    }

    set(key: CacheKey, entry: { value: unknown; expiresAt?: number; scope?: CacheScope }): number {
        const stamp = ++this._stamp;
        this._entries.set(keyOf(key), { ...entry, stamp });
        return stamp;
    }

    evict(method: string): void {
        const prefix = `${method}\0`;
        for (const k of this._entries.keys()) {
            if (k.startsWith(prefix)) this._entries.delete(k);
        }
    }

    clear(): void {
        this._entries.clear();
    }
}

function keyOf(key: CacheKey): string {
    return `${key.method}\0${key.partition ?? ''}\0${key.params ?? ''}`;
}

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
     * Per-method eviction-generation counter. {@linkcode evict} bumps it before
     * touching the store; {@linkcode captureGeneration} reads it before a list
     * walk's page 1; {@linkcode write} skips when it moved — so a
     * `list_changed` arriving mid-walk is not overwritten by the walk's stale
     * aggregate.
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
        private readonly _reportError: (error: unknown) => void = () => {}
    ) {}

    /**
     * Bump the per-method generation (so an in-flight {@linkcode write} for the
     * same method becomes a no-op) and evict the store entry. The generation
     * bump is unconditional and FIRST — the {@linkcode write} race guard relies
     * on the bump, not on the store's evict completing. A custom store's
     * `evict()` may throw or reject; the caller routes that to `onerror`.
     */
    async evict(method: string): Promise<void> {
        this._evictionGeneration.set(method, (this._evictionGeneration.get(method) ?? 0) + 1);
        await this._store.evict(method);
    }

    /** Snapshot the eviction generation for `method` before a list walk's page 1. */
    captureGeneration(method: string): number {
        return this._evictionGeneration.get(method) ?? 0;
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
     */
    async write(method: string, value: unknown, capturedGen: number): Promise<void> {
        if ((this._evictionGeneration.get(method) ?? 0) !== capturedGen) return;
        try {
            await this._store.set({ method }, { value: structuredClone(value) });
        } catch (error) {
            this._reportError(error);
        }
    }

    /** Read the cached entry for `{method}` (the four list verbs). */
    async read(method: string): Promise<CacheEntry | undefined> {
        return this._store.get({ method });
    }

    /**
     * Connection reset. The per-instance default store IS cleared
     * (connection-scoped); a user-supplied store is NOT — that would defeat
     * the only reason to supply one. The generation map and every derived
     * index are dropped regardless: they are connection-scoped even when the
     * backing store survives, so the next read re-derives from whatever the
     * store still holds. The default impl is synchronous, so the
     * `MaybePromise<void>` return is a plain void here and the caller need not
     * await.
     */
    resetForReconnect(): void {
        if (!this._isUserSupplied) void this._store.clear();
        this._evictionGeneration.clear();
        this._toolIndex = undefined;
        this._toolOutputValidatorIndex = undefined;
    }

    /**
     * The descriptor for tool `name` taken from the cached `tools/list` entry.
     * The `name → Tool` index is memoized against the entry's `stamp` and
     * re-derived only when the backing entry changes (mcp.d's `cachedTool`).
     * Returns `undefined` only when no `tools/list` response is held at all,
     * or the held list does not contain `name`.
     *
     * No production caller in the substrate commit — the stacked SEP-2243 PR
     * wires `callTool()`'s `Mcp-Param-*` mirroring through it.
     * {@linkcode outputValidator} is the substrate's own derived view over the
     * same entry.
     */
    async toolDefinition(name: string): Promise<Tool | undefined> {
        const entry = await this._store.get({ method: 'tools/list' });
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
     * must not poison every other tool's `callTool` — the callback returns
     * `undefined` (and warns naming the offender) for the bad one and the
     * index simply omits it.
     */
    async outputValidator<V>(name: string, compile: (tool: Tool) => V | undefined): Promise<V | undefined> {
        const entry = await this._store.get({ method: 'tools/list' });
        if (entry === undefined) {
            this._toolOutputValidatorIndex = undefined;
            return undefined;
        }
        if (this._toolOutputValidatorIndex?.stamp !== entry.stamp) {
            const byName = new Map<string, unknown>();
            for (const tool of (entry.value as ListToolsResult).tools) {
                if (tool.outputSchema) {
                    const validator = compile(tool);
                    if (validator !== undefined) byName.set(tool.name, validator);
                }
            }
            this._toolOutputValidatorIndex = { stamp: entry.stamp, byName };
        }
        return this._toolOutputValidatorIndex.byName.get(name) as V | undefined;
    }
}
