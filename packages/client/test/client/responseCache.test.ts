/**
 * Response-cache substrate: store primitives, the {@linkcode ClientResponseCache}
 * coordinator, and the Client's wiring (mcp.d's `cachedTool` pattern).
 *
 * Covers: `list*` auto-aggregation writing one entry; `list_changed` evicts
 * (does not refetch); `resetForReconnect` respects the user-supplied flag;
 * `toolDefinition` hit/miss and re-derivation only on a stamp change; the
 * generation guard skipping a stale write.
 */
import type { JSONRPCMessage, JSONRPCRequest, Tool } from '@modelcontextprotocol/core-internal';
import { InMemoryTransport, SdkError, SdkErrorCode } from '@modelcontextprotocol/core-internal';
import { describe, expect, it } from 'vitest';

import { Client } from '../../src/client/client';
import type { CacheEntry, ResponseCacheStore } from '../../src/client/responseCache';
import { ClientResponseCache, InMemoryResponseCacheStore } from '../../src/client/responseCache';

const MODERN = '2026-07-28';

const TOOL_A: Tool = { name: 'a', inputSchema: { type: 'object', properties: {} } };
const TOOL_B: Tool = { name: 'b', inputSchema: { type: 'object', properties: {} } };

/**
 * Partition the `Client` derives for the scripted server (`serverInfo:
 * {name:'scripted', version:'1.0.0'}`) and `principal` (default `''` ⇒ the
 * server's shared/public slot). The encoding is the same JSON-array form
 * `ClientResponseCache._partitionFor` produces.
 */
const part = (principal = '', serverIdentity = 'scripted@1.0.0'): string => JSON.stringify([serverIdentity, principal]);
/** The pre-connect / direct-`ClientResponseCache` sentinel partition (`['', '']`). */
const PRE = JSON.stringify(['', '']);

describe('InMemoryResponseCacheStore', () => {
    it('get/set/evict/clear round-trip; evict is method-scoped; set returns the store-generated stamp', () => {
        const store = new InMemoryResponseCacheStore();
        const s1 = store.set({ method: 'tools/list' }, { value: 1 });
        const s2 = store.set({ method: 'prompts/list' }, { value: 2 });
        const s3 = store.set({ method: 'resources/read', params: 'file:///a' }, { value: 3, expiresAt: 123, scope: 'private' });
        // Store owns the stamp counter: monotonic, opaque to callers, surfaced on the entry.
        expect(s2).toBeGreaterThan(s1);
        expect(s3).toBeGreaterThan(s2);
        expect(store.get({ method: 'tools/list' })).toEqual({ value: 1, stamp: s1 });
        // Store persists caller-supplied freshness metadata.
        expect(store.get({ method: 'resources/read', params: 'file:///a' })).toEqual({
            value: 3,
            stamp: s3,
            expiresAt: 123,
            scope: 'private'
        });
        expect(store.get({ method: 'tools/list', params: '', partition: '' })?.value).toBe(1);
        store.evict('tools/list');
        expect(store.get({ method: 'tools/list' })).toBeUndefined();
        expect(store.get({ method: 'prompts/list' })?.value).toBe(2);
        expect(store.get({ method: 'resources/read', params: 'file:///a' })?.value).toBe(3);
        store.clear();
        expect(store.get({ method: 'prompts/list' })).toBeUndefined();
    });

    it('partition is part of the key serialization; evict(method) is partition-agnostic', () => {
        const store = new InMemoryResponseCacheStore();
        store.set({ method: 'tools/list', partition: 'p1' }, { value: 'a' });
        store.set({ method: 'tools/list', partition: 'p2' }, { value: 'b' });
        expect(store.get({ method: 'tools/list', partition: 'p1' })?.value).toBe('a');
        expect(store.get({ method: 'tools/list', partition: 'p2' })?.value).toBe('b');
        // The default-partition slot is distinct.
        expect(store.get({ method: 'tools/list' })).toBeUndefined();
        // evict(method) is partition-agnostic.
        store.evict('tools/list');
        expect(store.get({ method: 'tools/list', partition: 'p1' })).toBeUndefined();
        expect(store.get({ method: 'tools/list', partition: 'p2' })).toBeUndefined();
    });

    it('keyOf is collision-free for NUL / quote / delimiter characters in partition and params', () => {
        const store = new InMemoryResponseCacheStore();
        // A NUL in `partition` cannot smuggle into `params` (and vice versa) —
        // the `[partition, params]` JSON-array encoding escapes every control
        // and quote character.
        store.set({ method: 'resources/read', partition: 'a\0b', params: 'c' }, { value: 1 });
        store.set({ method: 'resources/read', partition: 'a', params: 'b\0c' }, { value: 2 });
        expect(store.get({ method: 'resources/read', partition: 'a\0b', params: 'c' })?.value).toBe(1);
        expect(store.get({ method: 'resources/read', partition: 'a', params: 'b\0c' })?.value).toBe(2);
        // Same for the partition's own JSON-shaped content: the outer
        // JSON.stringify escapes the inner quotes.
        store.set({ method: 'tools/list', partition: '["x",""]' }, { value: 'real' });
        store.set({ method: 'tools/list', partition: '["x","' }, { value: 'spoof' });
        expect(store.get({ method: 'tools/list', partition: '["x",""]' })?.value).toBe('real');
    });

    it('maxEntries cap: oldest-first eviction; re-set of an existing key never evicts; 0 disables the bound', () => {
        const small = new InMemoryResponseCacheStore({ maxEntries: 2 });
        small.set({ method: 'resources/read', params: 'a' }, { value: 'a' });
        small.set({ method: 'resources/read', params: 'b' }, { value: 'b' });
        // Re-set of an existing key updates in place without consuming
        // capacity (Map preserves the original insertion position).
        small.set({ method: 'resources/read', params: 'a' }, { value: 'a2' });
        expect(small.size).toBe(2);
        expect(small.get({ method: 'resources/read', params: 'a' })?.value).toBe('a2');
        // A NEW key at capacity evicts the oldest insertion ('a').
        small.set({ method: 'resources/read', params: 'c' }, { value: 'c' });
        expect(small.get({ method: 'resources/read', params: 'a' })).toBeUndefined();
        expect(small.get({ method: 'resources/read', params: 'b' })?.value).toBe('b');
        expect(small.get({ method: 'resources/read', params: 'c' })?.value).toBe('c');
        expect(small.size).toBe(2);

        // 0 disables the bound.
        const unbounded = new InMemoryResponseCacheStore({ maxEntries: 0 });
        for (let i = 0; i < 1000; i++) unbounded.set({ method: 'resources/read', params: String(i) }, { value: i });
        expect(unbounded.size).toBe(1000);
    });

    it('maxEntries cap exempts list-singleton methods: a resources/read flood never evicts tools/list', () => {
        const store = new InMemoryResponseCacheStore({ maxEntries: 3 });
        // List singletons are exempt: never counted, never evicted by the cap.
        store.set({ method: 'tools/list' }, { value: 'T' });
        store.set({ method: 'prompts/list' }, { value: 'P' });
        store.set({ method: 'resources/list' }, { value: 'R' });
        store.set({ method: 'resources/templates/list' }, { value: 'RT' });
        store.set({ method: 'server/discover' }, { value: 'D' });
        // Five exempt entries already exceed maxEntries=3; a resources/read
        // write does NOT evict any of them — the cap counts only non-exempt
        // keys.
        for (let i = 0; i < 5; i++) store.set({ method: 'resources/read', params: String(i) }, { value: i });
        expect(store.get({ method: 'tools/list' })?.value).toBe('T');
        expect(store.get({ method: 'prompts/list' })?.value).toBe('P');
        expect(store.get({ method: 'resources/list' })?.value).toBe('R');
        expect(store.get({ method: 'resources/templates/list' })?.value).toBe('RT');
        expect(store.get({ method: 'server/discover' })?.value).toBe('D');
        // Only 3 resources/read entries survive (oldest two evicted).
        expect(store.get({ method: 'resources/read', params: '0' })).toBeUndefined();
        expect(store.get({ method: 'resources/read', params: '1' })).toBeUndefined();
        expect(store.get({ method: 'resources/read', params: '2' })?.value).toBe(2);
        expect(store.get({ method: 'resources/read', params: '4' })?.value).toBe(4);
        expect(store.size).toBe(8);
        // An exempt-method write at capacity never evicts a resources/read entry.
        store.set({ method: 'tools/list', partition: 'p2' }, { value: 'T2' });
        expect(store.get({ method: 'resources/read', params: '2' })?.value).toBe(2);
    });

    it('delete(key) drops the single entry; no-op when absent', () => {
        const store = new InMemoryResponseCacheStore();
        store.set({ method: 'resources/read', params: 'a', partition: 'p' }, { value: 1 });
        store.set({ method: 'resources/read', params: 'b', partition: 'p' }, { value: 2 });
        store.delete({ method: 'resources/read', params: 'a', partition: 'p' });
        expect(store.get({ method: 'resources/read', params: 'a', partition: 'p' })).toBeUndefined();
        expect(store.get({ method: 'resources/read', params: 'b', partition: 'p' })?.value).toBe(2);
        // Absent key: no-op.
        store.delete({ method: 'resources/read', params: 'a', partition: 'p' });
    });
});

describe('ClientResponseCache', () => {
    it('write skips when the captured generation moved (list_changed-during-walk guard)', async () => {
        const store = new InMemoryResponseCacheStore();
        const cache = new ClientResponseCache(store, false);
        const gen = cache.captureGeneration('tools/list');
        await cache.evict('tools/list');
        await cache.write('tools/list', { tools: [TOOL_A] }, gen);
        // Generation moved between capture and write → the stale aggregate is dropped.
        expect(store.get({ method: 'tools/list', partition: PRE })).toBeUndefined();
        // A fresh capture after the evict writes through.
        const gen2 = cache.captureGeneration('tools/list');
        await cache.write('tools/list', { tools: [TOOL_A] }, gen2);
        expect(store.get({ method: 'tools/list', partition: PRE })).toBeDefined();
    });

    it('resetForReconnect: clears the default store, leaves a user-supplied store, ALWAYS drops generation + indices', async () => {
        // User-supplied: store survives, generation map + derived index are dropped.
        const userStore = new InMemoryResponseCacheStore();
        const userCache = new ClientResponseCache(userStore, true);
        await userCache.write('tools/list', { tools: [TOOL_A] }, userCache.captureGeneration('tools/list'));
        expect((await userCache.toolDefinition('a'))?.name).toBe('a');
        await userCache.evict('prompts/list');
        expect(userCache.captureGeneration('prompts/list')).toBe(1);
        userCache.resetForReconnect();
        expect(userStore.get({ method: 'tools/list', partition: PRE })).toBeDefined();
        expect(userCache.captureGeneration('prompts/list')).toBe(0);
        // Index dropped → re-derived from the (still-populated) store on next read.
        expect((userCache as unknown as { _toolIndex?: unknown })._toolIndex).toBeUndefined();
        expect((await userCache.toolDefinition('a'))?.name).toBe('a');

        // Default: store is cleared.
        const defStore = new InMemoryResponseCacheStore();
        const defCache = new ClientResponseCache(defStore, false);
        await defCache.write('tools/list', { tools: [TOOL_A] }, defCache.captureGeneration('tools/list'));
        defCache.resetForReconnect();
        expect(defStore.get({ method: 'tools/list', partition: PRE })).toBeUndefined();
        expect(await defCache.toolDefinition('a')).toBeUndefined();
    });

    it('write stores a defensive copy: caller-side mutation cannot reach the cache or its derived index', async () => {
        const store = new InMemoryResponseCacheStore();
        const cache = new ClientResponseCache(store, false);
        const value = { tools: [{ ...TOOL_A }, { ...TOOL_B }] };
        await cache.write('tools/list', value, cache.captureGeneration('tools/list'));
        // Mutate the caller's reference (the same object _listAllPages returns).
        value.tools.length = 0;
        // The cached entry is a structuredClone, so the store and the
        // stamp-memoized index are unaffected.
        expect((store.get({ method: 'tools/list', partition: PRE })?.value as { tools: Tool[] }).tools.map(t => t.name)).toEqual([
            'a',
            'b'
        ]);
        expect((await cache.toolDefinition('a'))?.name).toBe('a');
        expect((await cache.toolDefinition('b'))?.name).toBe('b');
    });

    it('evictKey bumps the per-key generation so an in-flight write for the same {method, params} is suppressed', async () => {
        const store = new InMemoryResponseCacheStore();
        const cache = new ClientResponseCache(store, false);
        // Capture BEFORE the request; evictKey lands mid-flight; the stale
        // write is dropped (mirrors the list_changed-during-walk guard,
        // keyed per URI).
        const gen = cache.captureGeneration('resources/read', 'res://a');
        await cache.evictKey('resources/read', 'res://a');
        await cache.write('resources/read', { contents: [] }, gen, { expiresAt: 1e9, scope: 'private', params: 'res://a' });
        expect(store.get({ method: 'resources/read', params: 'res://a', partition: PRE })).toBeUndefined();
        // A sibling URI's generation is independent: evictKey('a') does not
        // suppress a write for 'b'.
        const genB = cache.captureGeneration('resources/read', 'res://b');
        await cache.evictKey('resources/read', 'res://a');
        await cache.write('resources/read', { contents: [] }, genB, { expiresAt: 1e9, scope: 'private', params: 'res://b' });
        expect(store.get({ method: 'resources/read', params: 'res://b', partition: PRE })).toBeDefined();
        // A fresh capture after the evictKey writes through.
        const gen2 = cache.captureGeneration('resources/read', 'res://a');
        await cache.write('resources/read', { contents: [] }, gen2, { expiresAt: 1e9, scope: 'private', params: 'res://a' });
        expect(store.get({ method: 'resources/read', params: 'res://a', partition: PRE })).toBeDefined();
    });

    it('evictKey: own-partition store.delete rejecting does not skip the shared-partition delete', async () => {
        const deleted: string[] = [];
        const store: ResponseCacheStore = {
            get: () => undefined,
            set: () => 0,
            evict: () => {},
            clear: () => {},
            delete: key => {
                if (key.partition === JSON.stringify(['srv', 'alice'])) return Promise.reject(new Error('own boom'));
                deleted.push(key.partition ?? '');
                return undefined;
            }
        };
        const reported: unknown[] = [];
        const cache = new ClientResponseCache(store, true, e => reported.push(e), 'alice');
        cache.setServerIdentity('srv');
        await cache.evictKey('resources/read', 'res://x');
        // Own-partition rejected → reported; shared-partition delete still ran.
        expect((reported[0] as Error).message).toBe('own boom');
        expect(deleted).toEqual([JSON.stringify(['srv', ''])]);
    });

    it("write/read/evict address the list singletons consistently as params: '' on a non-normalizing custom store", async () => {
        // A custom store that keys on the raw CacheKey without normalizing
        // omitted/undefined `params` to '' (e.g. JSON.stringify, which drops
        // undefined members). Every SDK→store call must therefore send the
        // SAME params shape so write/read/evict address one backend key.
        const entries = new Map<string, CacheEntry>();
        let stamp = 0;
        const store: ResponseCacheStore = {
            get: k => entries.get(JSON.stringify(k)),
            set: (k, e) => (entries.set(JSON.stringify(k), { ...e, stamp: ++stamp }), stamp),
            delete: k => void entries.delete(JSON.stringify(k)),
            evict: () => {},
            clear: () => entries.clear()
        };
        const cache = new ClientResponseCache(store, true);
        await cache.write('tools/list', { tools: [TOOL_A] }, cache.captureGeneration('tools/list'), {
            expiresAt: 1e9,
            scope: 'private'
        });
        // The read path finds the entry the write path stored.
        expect((await cache.read('tools/list'))?.value).toEqual({ tools: [TOOL_A] });
        // The list_changed eviction path deletes the SAME backend key — gone.
        await cache.evict('tools/list');
        expect(await cache.read('tools/list')).toBeUndefined();
        expect(entries.size).toBe(0);
    });

    it('a custom store whose set() rejects is routed to reportError and write still resolves', async () => {
        const store: ResponseCacheStore = new InMemoryResponseCacheStore();
        store.set = () => Promise.reject(new Error('redis down'));
        const reported: unknown[] = [];
        const cache = new ClientResponseCache(store, true, e => reported.push(e));
        // The write resolves (cache bookkeeping never costs the caller a fetched
        // result) and the failure is reported via the sink.
        await expect(cache.write('tools/list', { tools: [TOOL_A] }, cache.captureGeneration('tools/list'))).resolves.toBeUndefined();
        expect(reported).toHaveLength(1);
        expect((reported[0] as Error).message).toBe('redis down');
    });

    it('toolDefinition: miss before any list, hit after, memoized index re-derives only on stamp change', async () => {
        const store = new InMemoryResponseCacheStore();
        const cache = new ClientResponseCache(store, true);
        expect(await cache.toolDefinition('a')).toBeUndefined();

        store.set({ method: 'tools/list', partition: PRE }, { value: { tools: [TOOL_A, TOOL_B] } });
        const hit = await cache.toolDefinition('a');
        expect(hit?.name).toBe('a');
        // Same backing entry → identical reference (memoized index, not re-derived).
        expect(await cache.toolDefinition('a')).toBe(hit);

        // A fresh write bumps the store stamp → the index re-derives (the new
        // entry's tool instance is what comes back, not the memoized one).
        store.set({ method: 'tools/list', partition: PRE }, { value: { tools: [{ ...TOOL_A }, { ...TOOL_B }] } });
        const hit2 = await cache.toolDefinition('a');
        expect(hit2?.name).toBe('a');
        expect(hit2).not.toBe(hit);
    });
});

interface Scripted {
    clientTx: InMemoryTransport;
    serverTx: InMemoryTransport;
    listCount: () => number;
    listParams: () => ({ cursor?: string; _meta?: unknown } | undefined)[];
    wireCount: (method: string) => number;
}

interface ScriptOptions {
    listHint?: { ttlMs?: number; cacheScope?: 'public' | 'private' };
    readHint?: { ttlMs?: number; cacheScope?: 'public' | 'private' };
    serverInfo?: { name: string; version: string };
}

async function scriptedModernServer(pages: Tool[][], opts: ScriptOptions = {}): Promise<Scripted> {
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    let lists = 0;
    const wireCounts = new Map<string, number>();
    const params: ({ cursor?: string; _meta?: unknown } | undefined)[] = [];
    serverTx.onmessage = m => {
        const r = m as JSONRPCRequest;
        if (r.id === undefined) return;
        wireCounts.set(r.method, (wireCounts.get(r.method) ?? 0) + 1);
        if (r.method === 'server/discover') {
            void serverTx.send({
                jsonrpc: '2.0',
                id: r.id,
                result: {
                    resultType: 'complete',
                    supportedVersions: [MODERN],
                    capabilities: { tools: { listChanged: true }, prompts: {}, resources: {} },
                    serverInfo: opts.serverInfo ?? { name: 'scripted', version: '1.0.0' }
                }
            });
        } else if (r.method === 'tools/list') {
            lists++;
            params.push(r.params as { cursor?: string; _meta?: unknown } | undefined);
            const cursor = (r.params as { cursor?: string } | undefined)?.cursor;
            const idx = cursor === undefined ? 0 : Number(cursor);
            const next = idx + 1 < pages.length ? String(idx + 1) : undefined;
            void serverTx.send({
                jsonrpc: '2.0',
                id: r.id,
                result: {
                    resultType: 'complete',
                    ttlMs: opts.listHint?.ttlMs ?? 0,
                    cacheScope: opts.listHint?.cacheScope ?? 'private',
                    tools: pages[idx] ?? [],
                    ...(next !== undefined && { nextCursor: next })
                }
            });
        } else if (r.method === 'prompts/list' || r.method === 'resources/list' || r.method === 'resources/templates/list') {
            const key = r.method === 'prompts/list' ? 'prompts' : r.method === 'resources/list' ? 'resources' : 'resourceTemplates';
            void serverTx.send({
                jsonrpc: '2.0',
                id: r.id,
                result: {
                    resultType: 'complete',
                    ttlMs: opts.listHint?.ttlMs ?? 0,
                    cacheScope: opts.listHint?.cacheScope ?? 'private',
                    [key]: []
                }
            });
        } else if (r.method === 'resources/read') {
            const uri = (r.params as { uri: string }).uri;
            void serverTx.send({
                jsonrpc: '2.0',
                id: r.id,
                result: {
                    resultType: 'complete',
                    ...(opts.readHint?.ttlMs !== undefined && { ttlMs: opts.readHint.ttlMs }),
                    ...(opts.readHint?.cacheScope !== undefined && { cacheScope: opts.readHint.cacheScope }),
                    contents: [{ uri, mimeType: 'text/plain', text: `body:${uri}` }]
                }
            });
        }
    };
    await serverTx.start();
    return {
        clientTx,
        serverTx,
        listCount: () => lists,
        listParams: () => params,
        wireCount: m => wireCounts.get(m) ?? 0
    };
}

function modernClient(store?: InMemoryResponseCacheStore, extra?: { cachePartition?: string; defaultCacheTtlMs?: number }): Client {
    return new Client(
        { name: 'cache-client', version: '1.0.0' },
        { versionNegotiation: { mode: { pin: MODERN } }, ...(store && { responseCacheStore: store }), ...extra }
    );
}

/** Reach the private `_cache` collaborator for testing the derived view through the Client wiring. */
const cacheOf = (client: Client): ClientResponseCache => (client as unknown as { _cache: ClientResponseCache })._cache;
const toolDef = (client: Client, name: string): Promise<Tool | undefined> => cacheOf(client).toolDefinition(name);

describe('Client response-cache substrate', () => {
    it('listTools() with no cursor reads every page, writes one cache entry; listTools({cursor}) stays per-page and does not write', async () => {
        const store = new InMemoryResponseCacheStore();
        const { clientTx, listCount } = await scriptedModernServer([[TOOL_A], [TOOL_B]]);
        const client = modernClient(store);
        await client.connect(clientTx);

        // Explicit cursor → one page, NO cache write (partial pages never go in).
        const page = await client.listTools({ cursor: '1' });
        expect(page.tools.map(t => t.name)).toEqual(['b']);
        expect(page.nextCursor).toBeUndefined();
        expect(store.get({ method: 'tools/list', partition: part() })).toBeUndefined();
        expect(listCount()).toBe(1);

        // allPages: false → first page only, raw nextCursor preserved, NO cache write.
        const firstPage = await client.listTools(undefined, { allPages: false });
        expect(firstPage.tools.map(t => t.name)).toEqual(['a']);
        expect(firstPage.nextCursor).toBe('1');
        expect(store.get({ method: 'tools/list', partition: part() })).toBeUndefined();
        expect(listCount()).toBe(2);

        // No cursor → aggregates every page and writes one entry.
        const { tools, nextCursor } = await client.listTools();
        expect(tools.map(t => t.name)).toEqual(['a', 'b']);
        expect(nextCursor).toBeUndefined();
        expect(listCount()).toBe(4);

        const entry = store.get({ method: 'tools/list', partition: part() });
        expect((entry?.value as { tools: Tool[] }).tools.map(t => t.name)).toEqual(['a', 'b']);
    });

    it('the auto-aggregate path threads caller params (e.g. _meta trace context) into every page request', async () => {
        const { clientTx, listParams } = await scriptedModernServer([[TOOL_A], [TOOL_B], [TOOL_A]]);
        const client = modernClient();
        await client.connect(clientTx);

        const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
        const { tools } = await client.listTools({ _meta: { traceparent } });
        expect(tools.map(t => t.name)).toEqual(['a', 'b', 'a']);
        // _listAllPages threads {...baseParams} on page 1 and {...baseParams, cursor}
        // on every follow-up page, so the caller's _meta reaches every wire
        // request the walk issues.
        expect(listParams()).toHaveLength(3);
        for (const p of listParams()) {
            // The Protocol layer may auto-attach the modern-era envelope into
            // _meta; assert the caller's key is present rather than exact-match.
            expect((p?._meta as { traceparent?: string } | undefined)?.traceparent).toBe(traceparent);
        }
        expect(listParams().map(p => p?.cursor)).toEqual([undefined, '1', '2']);
    });

    it('mutating the returned aggregate does not corrupt the cache or its derived index', async () => {
        const { clientTx } = await scriptedModernServer([[TOOL_A], [TOOL_B]]);
        const client = modernClient();
        await client.connect(clientTx);

        const result = await client.listTools();
        expect((await toolDef(client, 'a'))?.name).toBe('a');
        // Common previously-harmless caller patterns.
        result.tools.sort((x, y) => y.name.localeCompare(x.name));
        result.tools.length = 0;
        // ClientResponseCache.write stored a structuredClone, so neither the
        // backing entry nor the stamp-memoized name → Tool index moved.
        expect((await toolDef(client, 'a'))?.name).toBe('a');
        expect((await toolDef(client, 'b'))?.name).toBe('b');
    });

    it('the auto-aggregate path throws SdkError(ListPaginationExceeded) when listMaxPages is hit and does not write a partial entry', async () => {
        const store = new InMemoryResponseCacheStore();
        const { clientTx } = await scriptedModernServer([[TOOL_A], [TOOL_B], [TOOL_A]]);
        const client = new Client(
            { name: 'cache-client', version: '1.0.0' },
            { versionNegotiation: { mode: { pin: MODERN } }, responseCacheStore: store, listMaxPages: 2 }
        );
        await client.connect(clientTx);

        const error = await client.listTools().catch(e => e as SdkError);
        expect(error).toBeInstanceOf(SdkError);
        expect((error as SdkError).code).toBe(SdkErrorCode.ListPaginationExceeded);
        expect((error as SdkError).message).toMatch(/exceeded listMaxPages \(2\); server pagination did not terminate/);
        expect((error as SdkError).data).toEqual({ method: 'tools/list', listMaxPages: 2 });
        // Aggregate-then-write: the throw happens before the cache write, so nothing is cached.
        expect(store.get({ method: 'tools/list', partition: part() })).toBeUndefined();
        // The per-page path is never capped.
        const page = await client.listTools({ cursor: '2' });
        expect(page.tools.map(t => t.name)).toEqual(['a']);
    });

    it('listPrompts/listResources/listResourceTemplates auto-aggregate and write the response cache', async () => {
        const store = new InMemoryResponseCacheStore();
        const { clientTx } = await scriptedModernServer([[TOOL_A]]);
        const client = modernClient(store);
        await client.connect(clientTx);

        await client.listPrompts();
        await client.listResources();
        await client.listResourceTemplates();
        expect(store.get({ method: 'prompts/list', partition: part() })).toBeDefined();
        expect(store.get({ method: 'resources/list', partition: part() })).toBeDefined();
        expect(store.get({ method: 'resources/templates/list', partition: part() })).toBeDefined();
    });

    it('toolDefinition through the Client wiring: miss before any list, hit after', async () => {
        const store = new InMemoryResponseCacheStore();
        const { clientTx } = await scriptedModernServer([[TOOL_A, TOOL_B]]);
        const client = modernClient(store);
        await client.connect(clientTx);

        expect(await toolDef(client, 'a')).toBeUndefined();
        await client.listTools();
        expect((await toolDef(client, 'a'))?.name).toBe('a');
        expect((await toolDef(client, 'b'))?.name).toBe('b');
    });

    it('notifications/tools/list_changed evicts the tools/list entry (no refetch)', async () => {
        const store = new InMemoryResponseCacheStore();
        const { clientTx, serverTx, listCount } = await scriptedModernServer([[TOOL_A]]);
        const client = modernClient(store);
        await client.connect(clientTx);
        await client.listTools();
        expect(store.get({ method: 'tools/list', partition: part() })).toBeDefined();
        expect(await toolDef(client, 'a')).toBeDefined();

        const before = listCount();
        await serverTx.send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' } as JSONRPCMessage);
        // Evicted, not refetched.
        expect(store.get({ method: 'tools/list', partition: part() })).toBeUndefined();
        expect(await toolDef(client, 'a')).toBeUndefined();
        expect(listCount()).toBe(before);
    });

    it('notifications/resources/list_changed evicts both resources list verbs', async () => {
        const store = new InMemoryResponseCacheStore();
        const { clientTx, serverTx } = await scriptedModernServer([[TOOL_A]]);
        const client = modernClient(store);
        await client.connect(clientTx);
        await client.listResources();
        await client.listResourceTemplates();
        expect(store.get({ method: 'resources/list', partition: part() })).toBeDefined();
        expect(store.get({ method: 'resources/templates/list', partition: part() })).toBeDefined();

        await serverTx.send({ jsonrpc: '2.0', method: 'notifications/resources/list_changed' } as JSONRPCMessage);
        expect(store.get({ method: 'resources/list', partition: part() })).toBeUndefined();
        expect(store.get({ method: 'resources/templates/list', partition: part() })).toBeUndefined();
    });

    it('_resetConnectionState leaves a user-supplied store untouched and drops the derived index', async () => {
        const store = new InMemoryResponseCacheStore();
        const { clientTx } = await scriptedModernServer([[TOOL_A]]);
        const client = modernClient(store);
        await client.connect(clientTx);
        await client.listTools();
        expect(store.get({ method: 'tools/list', partition: part() })).toBeDefined();

        await client.close();
        // A user-supplied store is NOT cleared on close/reconnect (defeats the
        // only reason to supply one); the per-instance default IS cleared.
        expect(store.get({ method: 'tools/list', partition: part() })).toBeDefined();
        // The derived index is connection-scoped regardless: it is dropped, and
        // the next read re-derives from the (still-populated) store.
        expect((cacheOf(client) as unknown as { _toolIndex?: unknown })._toolIndex).toBeUndefined();
    });

    it('a notification whose method is an Object.prototype name does not abort dispatch', async () => {
        const store = new InMemoryResponseCacheStore();
        const { clientTx, serverTx } = await scriptedModernServer([[TOOL_A]]);
        const client = modernClient(store);
        let fallback: string | undefined;
        client.fallbackNotificationHandler = async n => {
            fallback = n.method;
        };
        let errored = false;
        client.onerror = () => {
            errored = true;
        };
        await client.connect(clientTx);

        await serverTx.send({ jsonrpc: '2.0', method: 'constructor' } as JSONRPCMessage);
        // The `Object.hasOwn` guard means `constructor` (an inherited prototype
        // member) is NOT looked up as an eviction list and dispatch reaches the
        // fallback handler without an error.
        expect(errored).toBe(false);
        expect(fallback).toBe('constructor');
    });

    it('a custom store whose set() rejects is routed to onerror and the aggregate still returns', async () => {
        const store = new InMemoryResponseCacheStore();
        (store as ResponseCacheStore).set = () => Promise.reject(new Error('redis down'));
        const { clientTx } = await scriptedModernServer([[TOOL_A], [TOOL_B]]);
        const client = modernClient(store);
        const errors: Error[] = [];
        client.onerror = e => errors.push(e);
        await client.connect(clientTx);

        // Cache bookkeeping never costs the caller a result it already fetched
        // (consistent with the eviction path): the store failure is reported
        // via onerror and the fully-fetched aggregate still comes back.
        const { tools } = await client.listTools();
        expect(tools.map(t => t.name)).toEqual(['a', 'b']);
        expect(errors.map(e => e.message)).toContain('redis down');
    });

    it('a custom store whose delete() throws on the list_changed eviction path is routed to onerror and dispatch still runs', async () => {
        const store = new InMemoryResponseCacheStore();
        store.delete = () => {
            throw new Error('boom');
        };
        const { clientTx, serverTx } = await scriptedModernServer([[TOOL_A]]);
        const client = modernClient(store);
        let dispatched = false;
        client.setNotificationHandler('notifications/tools/list_changed', async () => {
            dispatched = true;
        });
        const errors: Error[] = [];
        client.onerror = e => errors.push(e);
        await client.connect(clientTx);

        await serverTx.send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' } as JSONRPCMessage);
        expect(errors.map(e => e.message)).toContain('boom');
        expect(dispatched).toBe(true);
    });
});

/** Freeze the cache's clock at `t` for deterministic freshness assertions. */
const setNow = (client: Client, t: number): void => {
    (cacheOf(client) as unknown as { _now: () => number })._now = () => t;
};

describe('Client honours cacheHints (SEP-2549)', () => {
    it('listTools(): within TTL → no wire request; after TTL → refetch', async () => {
        const { clientTx, listCount } = await scriptedModernServer([[TOOL_A, TOOL_B]], { listHint: { ttlMs: 30_000 } });
        const client = modernClient();
        await client.connect(clientTx);
        setNow(client, 1_000_000);

        const first = await client.listTools();
        expect(first.tools.map(t => t.name)).toEqual(['a', 'b']);
        expect(listCount()).toBe(1);

        // Within TTL → cache hit, no wire request.
        setNow(client, 1_020_000);
        const second = await client.listTools();
        expect(second.tools.map(t => t.name)).toEqual(['a', 'b']);
        expect(listCount()).toBe(1);
        // Clone-on-serve: hit is a fresh copy, not the stored object.
        expect(second).not.toBe(first);

        // After TTL → stale, refetch.
        setNow(client, 1_040_000);
        await client.listTools();
        expect(listCount()).toBe(2);
    });

    it("cacheMode: 'refresh' always fetches and re-stores; 'bypass' fetches without read or write", async () => {
        const store = new InMemoryResponseCacheStore();
        const { clientTx, listCount } = await scriptedModernServer([[TOOL_A]], { listHint: { ttlMs: 60_000 } });
        const client = modernClient(store);
        await client.connect(clientTx);
        setNow(client, 1_000_000);

        await client.listTools();
        expect(listCount()).toBe(1);
        const stamp1 = store.get({ method: 'tools/list', partition: part() })?.stamp;

        // 'refresh' ignores the still-fresh entry, fetches, and re-stores (new stamp).
        await client.listTools(undefined, { cacheMode: 'refresh' });
        expect(listCount()).toBe(2);
        const stamp2 = store.get({ method: 'tools/list', partition: part() })?.stamp;
        expect(stamp2).toBeGreaterThan(stamp1!);

        // 'bypass' fetches but neither reads nor writes the cache.
        await client.listTools(undefined, { cacheMode: 'bypass' });
        expect(listCount()).toBe(3);
        expect(store.get({ method: 'tools/list', partition: part() })?.stamp).toBe(stamp2);

        // Default 'use' still serves the entry 'refresh' wrote.
        await client.listTools();
        expect(listCount()).toBe(3);
    });

    it('listChanged eviction beats TTL: a still-fresh entry is dropped on the relevant notification', async () => {
        const { clientTx, serverTx, listCount } = await scriptedModernServer([[TOOL_A]], { listHint: { ttlMs: 60_000 } });
        const client = modernClient();
        await client.connect(clientTx);
        setNow(client, 1_000_000);

        await client.listTools();
        await client.listTools();
        expect(listCount()).toBe(1);

        // Relevant notification ⇒ entry immediately stale (spec): the next call refetches even within TTL.
        await serverTx.send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' } as JSONRPCMessage);
        await client.listTools();
        expect(listCount()).toBe(2);
    });

    it('defaultCacheTtlMs: 0 (the default) means always-fetch but mirroring still works', async () => {
        const { clientTx, listCount } = await scriptedModernServer([[TOOL_A]], { listHint: { ttlMs: 0 } });
        const client = modernClient();
        await client.connect(clientTx);
        setNow(client, 1_000_000);

        await client.listTools();
        // ttlMs:0 ⇒ expiresAt === now ⇒ never served from cache.
        await client.listTools();
        expect(listCount()).toBe(2);
        // …but the entry IS stored (retain-for-schema), so the derived index works.
        expect((await toolDef(client, 'a'))?.name).toBe('a');
    });

    it('an explicit server ttlMs:0 is honoured as immediately stale (server hint wins over defaultCacheTtlMs)', async () => {
        const { clientTx, listCount } = await scriptedModernServer([[TOOL_A]], { listHint: { ttlMs: 0 } });
        // defaultCacheTtlMs only applies when the result lacks ttlMs (e.g. a
        // legacy-era response); a 2026 server's explicit 0 is the spec's
        // "immediately stale" and is honoured as-is.
        const client = modernClient(undefined, { defaultCacheTtlMs: 60_000 });
        await client.connect(clientTx);
        setNow(client, 1_000_000);

        await client.listTools();
        await client.listTools();
        expect(listCount()).toBe(2);
    });

    it("same serverIdentity, different cachePartition: 'public' entries shared; 'private' entries isolated", async () => {
        const store = new InMemoryResponseCacheStore();
        // Public scope: alice writes, bob (different cachePartition, SAME server) reads from the server's shared partition.
        {
            const a = await scriptedModernServer([[TOOL_A]], { listHint: { ttlMs: 60_000, cacheScope: 'public' } });
            const alice = modernClient(store, { cachePartition: 'alice' });
            await alice.connect(a.clientTx);
            setNow(alice, 1_000_000);
            await alice.listTools();
            expect(a.listCount()).toBe(1);
            // Stored under the server's shared partition (`[serverIdentity, '']`).
            expect(store.get({ method: 'tools/list', partition: part() })?.scope).toBe('public');
            expect(store.get({ method: 'tools/list', partition: part('alice') })).toBeUndefined();

            const b = await scriptedModernServer([[TOOL_B]], { listHint: { ttlMs: 60_000, cacheScope: 'public' } });
            const bob = modernClient(store, { cachePartition: 'bob' });
            await bob.connect(b.clientTx);
            setNow(bob, 1_000_000);
            const { tools } = await bob.listTools();
            // Public-share across two clients of the SAME server on one store: bob is served alice's entry without a wire request.
            expect(tools.map(t => t.name)).toEqual(['a']);
            expect(b.listCount()).toBe(0);
        }
        store.clear();
        // Private scope: alice writes under her own partition; bob misses and fetches his own.
        {
            const a = await scriptedModernServer([[TOOL_A]], { listHint: { ttlMs: 60_000, cacheScope: 'private' } });
            const alice = modernClient(store, { cachePartition: 'alice' });
            await alice.connect(a.clientTx);
            setNow(alice, 1_000_000);
            await alice.listTools();
            expect(store.get({ method: 'tools/list', partition: part('alice') })?.scope).toBe('private');
            expect(store.get({ method: 'tools/list', partition: part() })).toBeUndefined();

            const b = await scriptedModernServer([[TOOL_B]], { listHint: { ttlMs: 60_000, cacheScope: 'private' } });
            const bob = modernClient(store, { cachePartition: 'bob' });
            await bob.connect(b.clientTx);
            setNow(bob, 1_000_000);
            const { tools } = await bob.listTools();
            // Own-partition miss + shared-partition miss ⇒ bob fetches; alice's private entry never crosses.
            expect(tools.map(t => t.name)).toEqual(['b']);
            expect(b.listCount()).toBe(1);
            // toolDefinition (mirroring source) reads from each client's own partition.
            expect((await toolDef(alice, 'a'))?.name).toBe('a');
            expect((await toolDef(bob, 'b'))?.name).toBe('b');
            expect(await toolDef(bob, 'a')).toBeUndefined();
        }
    });

    it("different serverIdentity on a shared store: no cross-talk even for 'public' entries", async () => {
        const store = new InMemoryResponseCacheStore();
        // Server X stamps public; client x writes under [x@1.0.0, ''].
        const sx = await scriptedModernServer([[TOOL_A]], {
            listHint: { ttlMs: 60_000, cacheScope: 'public' },
            serverInfo: { name: 'x', version: '1.0.0' }
        });
        const x = modernClient(store);
        await x.connect(sx.clientTx);
        setNow(x, 1_000_000);
        await x.listTools();
        expect(store.get({ method: 'tools/list', partition: part('', 'x@1.0.0') })?.scope).toBe('public');

        // Server Y on the SAME store: y misses x's entry (different serverIdentity) and fetches its own.
        const sy = await scriptedModernServer([[TOOL_B]], {
            listHint: { ttlMs: 60_000, cacheScope: 'public' },
            serverInfo: { name: 'y', version: '1.0.0' }
        });
        const y = modernClient(store);
        await y.connect(sy.clientTx);
        setNow(y, 1_000_000);
        const { tools } = await y.listTools();
        expect(tools.map(t => t.name)).toEqual(['b']);
        expect(sy.listCount()).toBe(1);
        // Both entries co-exist under their own server namespaces.
        expect(store.get({ method: 'tools/list', partition: part('', 'y@1.0.0') })?.scope).toBe('public');
        expect((await toolDef(x, 'a'))?.name).toBe('a');
        expect(await toolDef(y, 'a')).toBeUndefined();
    });

    it("list_changed eviction is partition-scoped on a shared store: one server's notification leaves co-tenants' entries intact", async () => {
        const store = new InMemoryResponseCacheStore();
        // Two clients on DIFFERENT servers share one store. Each has a fresh
        // public tools/list entry under its own server-identity partition.
        const sx = await scriptedModernServer([[TOOL_A]], {
            listHint: { ttlMs: 60_000, cacheScope: 'public' },
            serverInfo: { name: 'x', version: '1.0.0' }
        });
        const x = modernClient(store);
        await x.connect(sx.clientTx);
        setNow(x, 1_000_000);
        await x.listTools();

        const sy = await scriptedModernServer([[TOOL_B]], {
            listHint: { ttlMs: 60_000, cacheScope: 'public' },
            serverInfo: { name: 'y', version: '1.0.0' }
        });
        const y = modernClient(store);
        await y.connect(sy.clientTx);
        setNow(y, 1_000_000);
        await y.listTools();
        expect(store.get({ method: 'tools/list', partition: part('', 'x@1.0.0') })).toBeDefined();
        expect(store.get({ method: 'tools/list', partition: part('', 'y@1.0.0') })).toBeDefined();

        // Server X sends list_changed → only x's entry is dropped; y's
        // co-tenant entry survives (evict() targets the connected server's
        // two partition singletons, never the method-wide store.evict()).
        await sx.serverTx.send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' } as JSONRPCMessage);
        expect(store.get({ method: 'tools/list', partition: part('', 'x@1.0.0') })).toBeUndefined();
        expect(store.get({ method: 'tools/list', partition: part('', 'y@1.0.0') })).toBeDefined();
        // y still cache-serves its own entry without a wire request.
        await y.listTools();
        expect(sy.listCount()).toBe(1);
        expect((await toolDef(y, 'b'))?.name).toBe('b');
    });

    it("a malicious serverInfo cannot bleed into another server's principal slot (JSON encoding is collision-free)", async () => {
        const store = new InMemoryResponseCacheStore();
        // The legitimate server B with principal 'victim'. Under naive
        // `${name}@${version}|${cachePartition}` concat its private partition
        // would be `realServer@1.0|victim`.
        const sb = await scriptedModernServer([[TOOL_B]], {
            listHint: { ttlMs: 60_000, cacheScope: 'private' },
            serverInfo: { name: 'realServer', version: '1.0' }
        });
        const victim = modernClient(store, { cachePartition: 'victim' });
        await victim.connect(sb.clientTx);
        setNow(victim, 1_000_000);
        await victim.listTools();
        expect(sb.listCount()).toBe(1);

        // A malicious server A whose `name` embeds `@`/`|` to target B's
        // naive-concat private slot. With JSON encoding the partition is
        // `["realServer@1.0|victim@",""]` ≠ `["realServer@1.0","victim"]` —
        // no collision possible regardless of what characters the
        // server-controlled string carries.
        const sa = await scriptedModernServer([[TOOL_A]], {
            listHint: { ttlMs: 60_000, cacheScope: 'public' },
            serverInfo: { name: 'realServer@1.0|victim', version: '' }
        });
        const attacker = modernClient(store);
        await attacker.connect(sa.clientTx);
        setNow(attacker, 1_000_000);
        await attacker.listTools();

        // B's private entry is unreachable from A (and vice versa): victim
        // still cache-serves its own entry, attacker never observed it.
        const again = await victim.listTools();
        expect(again.tools.map(t => t.name)).toEqual(['b']);
        expect(sb.listCount()).toBe(1);
        expect(await toolDef(attacker, 'b')).toBeUndefined();
        expect((await toolDef(victim, 'b'))?.name).toBe('b');
    });

    it("a server flipping cacheScope private→public on a 'refresh' deletes the shadowing private-partition entry", async () => {
        const store = new InMemoryResponseCacheStore();
        const pages: Tool[][] = [[TOOL_A]];
        const opts: ScriptOptions = { listHint: { ttlMs: 60_000, cacheScope: 'private' } };
        const a = await scriptedModernServer(pages, opts);
        const alice = modernClient(store, { cachePartition: 'alice' });
        await alice.connect(a.clientTx);
        setNow(alice, 1_000_000);
        // Warm: private-scoped → stored under [serverIdentity, 'alice'].
        await alice.listTools();
        expect(store.get({ method: 'tools/list', partition: part('alice') })?.scope).toBe('private');
        // Server flips the same key's scope to 'public' AND changes the body.
        opts.listHint = { ttlMs: 60_000, cacheScope: 'public' };
        pages[0] = [TOOL_B];
        await alice.listTools(undefined, { cacheMode: 'refresh' });
        // Fresh body stored at the shared partition; the now-stale private
        // entry is DELETED so it cannot shadow the public one on the
        // own-first probe.
        expect(store.get({ method: 'tools/list', partition: part() })?.scope).toBe('public');
        expect(store.get({ method: 'tools/list', partition: part('alice') })).toBeUndefined();
        // Next default-mode read serves the FRESH public body from cache (no wire).
        const { tools } = await alice.listTools();
        expect(tools.map(t => t.name)).toEqual(['b']);
        expect(a.listCount()).toBe(2);
    });

    it("the shared-partition fallback drops entries whose stored scope is not 'public' (misconfigured-co-tenant guard)", async () => {
        const store = new InMemoryResponseCacheStore();
        // A misconfigured co-tenant (omits cachePartition, default '') writes a
        // PRIVATE-scoped entry — which lands at the server's shared partition.
        const a = await scriptedModernServer([[TOOL_A]], { listHint: { ttlMs: 60_000, cacheScope: 'private' } });
        const misconfigured = modernClient(store);
        await misconfigured.connect(a.clientTx);
        setNow(misconfigured, 1_000_000);
        await misconfigured.listTools();
        expect(store.get({ method: 'tools/list', partition: part() })?.scope).toBe('private');

        // A correctly-partitioned client probes own partition (miss), then the
        // shared one — which holds the misconfigured client's PRIVATE entry.
        // The `entry.scope === 'public'` gate drops it; bob fetches over the
        // wire instead of leaking the private body.
        const b = await scriptedModernServer([[TOOL_B]], { listHint: { ttlMs: 60_000, cacheScope: 'private' } });
        const bob = modernClient(store, { cachePartition: 'bob' });
        await bob.connect(b.clientTx);
        setNow(bob, 1_000_000);
        const { tools } = await bob.listTools();
        expect(tools.map(t => t.name)).toEqual(['b']);
        expect(b.listCount()).toBe(1);
    });

    it('readResource(): keyed by uri, partitioned by scope, absent cacheScope is private; ttl≤0 is not stored', async () => {
        const store = new InMemoryResponseCacheStore();
        const { clientTx, wireCount } = await scriptedModernServer([[TOOL_A]], {
            readHint: { ttlMs: 60_000, cacheScope: 'private' }
        });
        const client = modernClient(store, { cachePartition: 'alice' });
        await client.connect(clientTx);
        setNow(client, 1_000_000);

        const r1 = await client.readResource({ uri: 'res://one' });
        expect(r1.contents[0]).toMatchObject({ text: 'body:res://one' });
        expect(wireCount('resources/read')).toBe(1);
        // Within TTL → cache hit on the same uri.
        const r2 = await client.readResource({ uri: 'res://one' });
        expect(r2.contents[0]).toMatchObject({ text: 'body:res://one' });
        expect(wireCount('resources/read')).toBe(1);
        // Different uri → distinct key, fetch.
        await client.readResource({ uri: 'res://two' });
        expect(wireCount('resources/read')).toBe(2);
        // 'refresh' on the first uri → fetch.
        await client.readResource({ uri: 'res://one' }, { cacheMode: 'refresh' });
        expect(wireCount('resources/read')).toBe(3);
        // Stored under alice's partition only (private).
        expect(store.get({ method: 'resources/read', params: 'res://one', partition: part('alice') })).toBeDefined();
        expect(store.get({ method: 'resources/read', params: 'res://one', partition: part() })).toBeUndefined();

        // bob on a shared store cannot read alice's private resource body.
        const b = await scriptedModernServer([[TOOL_A]], { readHint: { ttlMs: 60_000, cacheScope: 'private' } });
        const bob = modernClient(store, { cachePartition: 'bob' });
        await bob.connect(b.clientTx);
        setNow(bob, 1_000_000);
        await bob.readResource({ uri: 'res://one' });
        expect(b.wireCount('resources/read')).toBe(1);
    });

    // The wire codec rejects a 2026-07-28 cacheable result without `cacheScope`
    // (it is a required field), so the absent-scope path is unreachable through
    // `request()`. The `_freshness` private-default is defence-in-depth only;
    // the partition test above asserts the explicit-`'private'` storage slot.

    it('readResource(): ttl≤0 is not stored (unbounded URI keyspace) but the result still returns', async () => {
        const store = new InMemoryResponseCacheStore();
        const { clientTx, wireCount } = await scriptedModernServer([[TOOL_A]], { readHint: { ttlMs: 0, cacheScope: 'public' } });
        const client = modernClient(store);
        await client.connect(clientTx);
        setNow(client, 1_000_000);
        const r = await client.readResource({ uri: 'res://x' });
        expect(r.contents[0]).toMatchObject({ text: 'body:res://x' });
        expect(store.get({ method: 'resources/read', params: 'res://x', partition: part() })).toBeUndefined();
        await client.readResource({ uri: 'res://x' });
        expect(wireCount('resources/read')).toBe(2);
    });

    it('readResource(): 600 distinct ttl=0 URIs issue zero store.delete() calls (evictKey skipped on a cold default-mode miss)', async () => {
        // Regression: every ttl≤0 default-mode read used to call
        // `evictKey('resources/read', uri)` unconditionally, which issued 1–2
        // `store.delete()` calls against a cold key — wasted round trips on
        // an async store across a ttl≤0 working set. The evict is now skipped
        // when `_serveFromCache` already proved nothing fresh is held.
        const store = new InMemoryResponseCacheStore();
        let deletes = 0;
        const realDelete = store.delete.bind(store);
        (store as ResponseCacheStore).delete = key => {
            deletes++;
            return realDelete(key);
        };
        const { clientTx } = await scriptedModernServer([[TOOL_A]], { readHint: { ttlMs: 0, cacheScope: 'public' } });
        const client = modernClient(store);
        await client.connect(clientTx);
        setNow(client, 1_000_000);

        for (let i = 0; i < 600; i++) await client.readResource({ uri: `res://cold/${i}` });
        expect(store.size).toBe(0);
        // No store.delete() issued for any of the 600 cold-miss ttl≤0 reads.
        expect(deletes).toBe(0);
        // `captureGeneration` recorded one entry per read URI (the in-flight
        // guard's presence record); none was bumped — `evictKey` was never
        // reached. The map is bounded by keys the CLIENT chose to read.
        const gen = (cacheOf(client) as unknown as { _evictionGeneration: Map<string, number> })._evictionGeneration;
        expect(gen.size).toBe(600);
        expect([...gen.values()].every(v => v === 0)).toBe(true);
    });

    it('600 distinct-URI notifications/resources/updated with no prior readResource do not grow the eviction-generation map; a read URI is still guarded', async () => {
        // Regression: `evictKey` used to bump (and therefore record) the
        // per-URI generation unconditionally, so a server streaming
        // `resources/updated` for distinct URIs grew `_evictionGeneration`
        // without bound — server-controlled heap growth. `evictKey` now only
        // bumps a key the client has captured.
        const store = new InMemoryResponseCacheStore();
        const { clientTx, serverTx } = await scriptedModernServer([[TOOL_A]], {
            readHint: { ttlMs: 60_000, cacheScope: 'private' }
        });
        const client = modernClient(store);
        await client.connect(clientTx);
        setNow(client, 1_000_000);
        const gen = (cacheOf(client) as unknown as { _evictionGeneration: Map<string, number> })._evictionGeneration;

        for (let i = 0; i < 600; i++) {
            await serverTx.send({
                jsonrpc: '2.0',
                method: 'notifications/resources/updated',
                params: { uri: `res://never-read/${i}` }
            } as JSONRPCMessage);
        }
        expect(gen.size).toBe(0);

        // A URI the client HAS read is recorded by captureGeneration; an
        // `updated` for it bumps (the in-flight guard still works).
        await client.readResource({ uri: 'res://hot' });
        expect(cacheOf(client).captureGeneration('resources/read', 'res://hot')).toBe(0);
        await serverTx.send({
            jsonrpc: '2.0',
            method: 'notifications/resources/updated',
            params: { uri: 'res://hot' }
        } as JSONRPCMessage);
        expect(cacheOf(client).captureGeneration('resources/read', 'res://hot')).toBe(1);
        expect(gen.size).toBe(1);
    });

    it("readResource(): a 'refresh' that returns ttl≤0 evicts the previously-warm entry; the next default-mode read fetches fresh", async () => {
        const store = new InMemoryResponseCacheStore();
        const opts: ScriptOptions = { readHint: { ttlMs: 60_000, cacheScope: 'private' } };
        const { clientTx, wireCount } = await scriptedModernServer([[TOOL_A]], opts);
        const client = modernClient(store, { cachePartition: 'alice' });
        await client.connect(clientTx);
        setNow(client, 1_000_000);

        // Warm: ttl=60s.
        await client.readResource({ uri: 'res://x' });
        expect(wireCount('resources/read')).toBe(1);
        await client.readResource({ uri: 'res://x' });
        expect(wireCount('resources/read')).toBe(1);
        expect(store.get({ method: 'resources/read', params: 'res://x', partition: part('alice') })).toBeDefined();

        // Server flips to ttl=0; a 'refresh' fetch returns ttl≤0 → the held
        // positive-TTL entry is evicted, not left stale-but-fresh.
        opts.readHint = { ttlMs: 0, cacheScope: 'private' };
        await client.readResource({ uri: 'res://x' }, { cacheMode: 'refresh' });
        expect(wireCount('resources/read')).toBe(2);
        expect(store.get({ method: 'resources/read', params: 'res://x', partition: part('alice') })).toBeUndefined();

        // The next default-mode read fetches fresh (the entry was evicted).
        await client.readResource({ uri: 'res://x' });
        expect(wireCount('resources/read')).toBe(3);
    });

    it('a pre-aborted signal on a warm-cache hit rejects with SdkError(RequestTimeout) — the abort is not swallowed by the cache serve', async () => {
        const store = new InMemoryResponseCacheStore();
        const { clientTx, listCount } = await scriptedModernServer([[TOOL_A]], { listHint: { ttlMs: 60_000, cacheScope: 'public' } });
        const client = modernClient(store);
        await client.connect(clientTx);
        setNow(client, 1_000_000);

        await client.listTools();
        expect(listCount()).toBe(1);
        // Warm — a plain second call would be cache-served. With a pre-aborted
        // signal it must reject the same way the wire path would.
        const ac = new AbortController();
        ac.abort('user cancelled');
        const error = await client.listTools(undefined, { signal: ac.signal }).catch(e => e as SdkError);
        expect(error).toBeInstanceOf(SdkError);
        expect((error as SdkError).code).toBe(SdkErrorCode.RequestTimeout);
        expect((error as SdkError).message).toContain('user cancelled');
        // The aborted call did not reach the wire.
        expect(listCount()).toBe(1);
    });

    it('notifications/resources/updated evicts the cached resources/read entry for that URI from both partitions', async () => {
        const store = new InMemoryResponseCacheStore();
        const { clientTx, serverTx, wireCount } = await scriptedModernServer([[TOOL_A]], {
            readHint: { ttlMs: 60_000, cacheScope: 'private' }
        });
        const client = modernClient(store, { cachePartition: 'alice' });
        await client.connect(clientTx);
        setNow(client, 1_000_000);

        await client.readResource({ uri: 'res://one' });
        await client.readResource({ uri: 'res://two' });
        expect(wireCount('resources/read')).toBe(2);
        // Within TTL → cache hit.
        await client.readResource({ uri: 'res://one' });
        expect(wireCount('resources/read')).toBe(2);

        // Subscribe → updated → re-read flow: the per-URI eviction drops the
        // cached body from BOTH partitions; the next read for THAT uri
        // refetches even within TTL; the sibling uri is untouched.
        await serverTx.send({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri: 'res://one' } } as JSONRPCMessage);
        expect(store.get({ method: 'resources/read', params: 'res://one', partition: part('alice') })).toBeUndefined();
        await client.readResource({ uri: 'res://one' });
        expect(wireCount('resources/read')).toBe(3);
        await client.readResource({ uri: 'res://two' });
        expect(wireCount('resources/read')).toBe(3);

        // A `resources/updated` without a string `uri` is a no-op (matches the
        // mcp.d guard).
        await serverTx.send({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: {} } as JSONRPCMessage);
        await client.readResource({ uri: 'res://one' });
        expect(wireCount('resources/read')).toBe(3);
    });

    it('ttlMs is clamped at 24h (MAX_CACHE_TTL_MS) so a server cannot pin an entry indefinitely', async () => {
        const store = new InMemoryResponseCacheStore();
        const { clientTx, listCount } = await scriptedModernServer([[TOOL_A]], {
            listHint: { ttlMs: Number.MAX_SAFE_INTEGER, cacheScope: 'public' }
        });
        const client = modernClient(store);
        await client.connect(clientTx);
        setNow(client, 1_000_000);
        await client.listTools();
        const entry = store.get({ method: 'tools/list', partition: part() });
        // expiresAt = now + min(ttlMs, 24h)
        expect(entry?.expiresAt).toBe(1_000_000 + 86_400_000);
        // Just under 24h → still served from cache.
        setNow(client, 1_000_000 + 86_400_000 - 1);
        await client.listTools();
        expect(listCount()).toBe(1);
        // Past 24h → refetch.
        setNow(client, 1_000_000 + 86_400_000 + 1);
        await client.listTools();
        expect(listCount()).toBe(2);
    });

    it('the default in-memory store is bounded: 600 distinct readResource URIs cap at 512 with oldest-first eviction', async () => {
        const store = new InMemoryResponseCacheStore();
        const { clientTx } = await scriptedModernServer([[TOOL_A]], { readHint: { ttlMs: 60_000, cacheScope: 'public' } });
        const client = modernClient(store);
        await client.connect(clientTx);
        setNow(client, 1_000_000);

        for (let i = 0; i < 600; i++) await client.readResource({ uri: `res://${i}` });
        expect(store.size).toBe(512);
        // The first 88 URIs (oldest insertions) were evicted; the tail survived.
        expect(store.get({ method: 'resources/read', params: 'res://0', partition: part() })).toBeUndefined();
        expect(store.get({ method: 'resources/read', params: 'res://87', partition: part() })).toBeUndefined();
        expect(store.get({ method: 'resources/read', params: 'res://88', partition: part() })).toBeDefined();
        expect(store.get({ method: 'resources/read', params: 'res://599', partition: part() })).toBeDefined();
    });

    it('the maxEntries cap never evicts the tools/list singleton: 600 readResource URIs leave the derived index intact', async () => {
        const store = new InMemoryResponseCacheStore();
        const { clientTx, listCount } = await scriptedModernServer([[TOOL_A]], {
            listHint: { ttlMs: 60_000, cacheScope: 'public' },
            readHint: { ttlMs: 60_000, cacheScope: 'public' }
        });
        const client = modernClient(store);
        await client.connect(clientTx);
        setNow(client, 1_000_000);

        await client.listTools();
        expect((await toolDef(client, 'a'))?.name).toBe('a');
        for (let i = 0; i < 600; i++) await client.readResource({ uri: `res://${i}` });
        // 512 capped resources/read entries + the exempt tools/list singleton.
        expect(store.size).toBe(513);
        // The list singleton survived the FIFO churn → derived index still hits;
        // a fresh listTools() within TTL is still cache-served.
        expect(store.get({ method: 'tools/list', partition: part() })).toBeDefined();
        expect((await toolDef(client, 'a'))?.name).toBe('a');
        await client.listTools();
        expect(listCount()).toBe(1);
    });

    it('an in-flight readResource() does not re-cache a stale body when resources/updated for that URI lands mid-request', async () => {
        const store = new InMemoryResponseCacheStore();
        const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
        let reads = 0;
        let pendingId: string | number | undefined;
        serverTx.onmessage = m => {
            const r = m as JSONRPCRequest;
            if (r.id === undefined) return;
            if (r.method === 'server/discover') {
                void serverTx.send({
                    jsonrpc: '2.0',
                    id: r.id,
                    result: {
                        resultType: 'complete',
                        supportedVersions: [MODERN],
                        capabilities: { resources: {} },
                        serverInfo: { name: 'scripted', version: '1.0.0' }
                    }
                });
            } else if (r.method === 'resources/read') {
                reads++;
                pendingId = r.id; // defer — the test drives the response
            }
        };
        await serverTx.start();
        const client = modernClient(store, { cachePartition: 'alice' });
        await client.connect(clientTx);
        setNow(client, 1_000_000);

        const respond = (text: string): void =>
            void serverTx.send({
                jsonrpc: '2.0',
                id: pendingId!,
                result: {
                    resultType: 'complete',
                    ttlMs: 60_000,
                    cacheScope: 'private',
                    contents: [{ uri: 'res://x', mimeType: 'text/plain', text }]
                }
            });

        // Kick off the read; let the request reach the server.
        const inflight = client.readResource({ uri: 'res://x' });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(reads).toBe(1);
        // resources/updated for THIS uri lands while the read is in flight →
        // bumps the per-URI generation; the eventual write is suppressed.
        await serverTx.send({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri: 'res://x' } } as JSONRPCMessage);
        respond('stale');
        const r1 = await inflight;
        expect(r1.contents[0]).toMatchObject({ text: 'stale' });
        expect(store.get({ method: 'resources/read', params: 'res://x', partition: part('alice') })).toBeUndefined();

        // The next read for the same URI refetches (no stale cache hit) and
        // its write goes through (fresh capture).
        const next = client.readResource({ uri: 'res://x' });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(reads).toBe(2);
        respond('fresh');
        expect((await next).contents[0]).toMatchObject({ text: 'fresh' });
        expect(store.get({ method: 'resources/read', params: 'res://x', partition: part('alice') })).toBeDefined();
    });

    it('a custom store whose get() rejects degrades to a miss; the request still reaches the wire', async () => {
        const store = new InMemoryResponseCacheStore();
        (store as ResponseCacheStore).get = () => Promise.reject(new Error('redis down'));
        const { clientTx, listCount } = await scriptedModernServer([[TOOL_A]], { listHint: { ttlMs: 60_000 } });
        const client = modernClient(store);
        const errors: Error[] = [];
        client.onerror = e => errors.push(e);
        await client.connect(clientTx);
        setNow(client, 1_000_000);

        const { tools } = await client.listTools();
        expect(tools.map(t => t.name)).toEqual(['a']);
        expect(listCount()).toBe(1);
        expect(errors.map(e => e.message)).toContain('redis down');
    });
});
