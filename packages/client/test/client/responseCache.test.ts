/**
 * Response-cache substrate: store primitives, the {@linkcode ClientResponseCache}
 * coordinator, and the Client's wiring (mcp.d's `cachedTool` pattern).
 *
 * Covers: `list*` auto-aggregation writing one entry; `list_changed` evicts
 * (does not refetch); `resetForReconnect` respects the user-supplied flag;
 * `toolDefinition` hit/miss and re-derivation only on a stamp change; the
 * generation guard skipping a stale write.
 */
import type { JSONRPCMessage, JSONRPCRequest, Tool } from '@modelcontextprotocol/core';
import { InMemoryTransport, SdkError, SdkErrorCode } from '@modelcontextprotocol/core';
import { describe, expect, it } from 'vitest';

import { Client } from '../../src/client/client.js';
import type { ResponseCacheStore } from '../../src/client/responseCache.js';
import { ClientResponseCache, InMemoryResponseCacheStore } from '../../src/client/responseCache.js';

const MODERN = '2026-07-28';

const TOOL_A: Tool = { name: 'a', inputSchema: { type: 'object', properties: {} } };
const TOOL_B: Tool = { name: 'b', inputSchema: { type: 'object', properties: {} } };

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
        // Store persists caller-supplied freshness metadata (#39 wires population; the slot exists today).
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

    it('partition is part of the key serialization (always empty today; #39 wires population)', () => {
        const store = new InMemoryResponseCacheStore();
        store.set({ method: 'tools/list', partition: 'p1' }, { value: 'a' });
        store.set({ method: 'tools/list', partition: 'p2' }, { value: 'b' });
        expect(store.get({ method: 'tools/list', partition: 'p1' })?.value).toBe('a');
        expect(store.get({ method: 'tools/list', partition: 'p2' })?.value).toBe('b');
        // The Client never populates partition today, so the default-partition slot is distinct.
        expect(store.get({ method: 'tools/list' })).toBeUndefined();
        // evict(method) is partition-agnostic.
        store.evict('tools/list');
        expect(store.get({ method: 'tools/list', partition: 'p1' })).toBeUndefined();
        expect(store.get({ method: 'tools/list', partition: 'p2' })).toBeUndefined();
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
        expect(store.get({ method: 'tools/list' })).toBeUndefined();
        // A fresh capture after the evict writes through.
        const gen2 = cache.captureGeneration('tools/list');
        await cache.write('tools/list', { tools: [TOOL_A] }, gen2);
        expect(store.get({ method: 'tools/list' })).toBeDefined();
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
        expect(userStore.get({ method: 'tools/list' })).toBeDefined();
        expect(userCache.captureGeneration('prompts/list')).toBe(0);
        // Index dropped → re-derived from the (still-populated) store on next read.
        expect((userCache as unknown as { _toolIndex?: unknown })._toolIndex).toBeUndefined();
        expect((await userCache.toolDefinition('a'))?.name).toBe('a');

        // Default: store is cleared.
        const defStore = new InMemoryResponseCacheStore();
        const defCache = new ClientResponseCache(defStore, false);
        await defCache.write('tools/list', { tools: [TOOL_A] }, defCache.captureGeneration('tools/list'));
        defCache.resetForReconnect();
        expect(defStore.get({ method: 'tools/list' })).toBeUndefined();
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
        expect((store.get({ method: 'tools/list' })?.value as { tools: Tool[] }).tools.map(t => t.name)).toEqual(['a', 'b']);
        expect((await cache.toolDefinition('a'))?.name).toBe('a');
        expect((await cache.toolDefinition('b'))?.name).toBe('b');
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

        store.set({ method: 'tools/list' }, { value: { tools: [TOOL_A, TOOL_B] } });
        const hit = await cache.toolDefinition('a');
        expect(hit?.name).toBe('a');
        // Same backing entry → identical reference (memoized index, not re-derived).
        expect(await cache.toolDefinition('a')).toBe(hit);

        // A fresh write bumps the store stamp → the index re-derives (the new
        // entry's tool instance is what comes back, not the memoized one).
        store.set({ method: 'tools/list' }, { value: { tools: [{ ...TOOL_A }, { ...TOOL_B }] } });
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
}

async function scriptedModernServer(pages: Tool[][]): Promise<Scripted> {
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    let lists = 0;
    const params: ({ cursor?: string; _meta?: unknown } | undefined)[] = [];
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
                    capabilities: { tools: { listChanged: true }, prompts: {}, resources: {} },
                    serverInfo: { name: 'scripted', version: '1.0.0' }
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
                    ttlMs: 0,
                    cacheScope: 'private',
                    tools: pages[idx] ?? [],
                    ...(next !== undefined && { nextCursor: next })
                }
            });
        } else if (r.method === 'prompts/list' || r.method === 'resources/list' || r.method === 'resources/templates/list') {
            const key = r.method === 'prompts/list' ? 'prompts' : r.method === 'resources/list' ? 'resources' : 'resourceTemplates';
            void serverTx.send({
                jsonrpc: '2.0',
                id: r.id,
                result: { resultType: 'complete', ttlMs: 0, cacheScope: 'private', [key]: [] }
            });
        }
    };
    await serverTx.start();
    return { clientTx, serverTx, listCount: () => lists, listParams: () => params };
}

function modernClient(store?: InMemoryResponseCacheStore): Client {
    return new Client(
        { name: 'cache-client', version: '1.0.0' },
        { versionNegotiation: { mode: { pin: MODERN } }, ...(store && { responseCacheStore: store }) }
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
        expect(store.get({ method: 'tools/list' })).toBeUndefined();
        expect(listCount()).toBe(1);

        // No cursor → aggregates every page and writes one entry.
        const { tools, nextCursor } = await client.listTools();
        expect(tools.map(t => t.name)).toEqual(['a', 'b']);
        expect(nextCursor).toBeUndefined();
        expect(listCount()).toBe(3);

        const entry = store.get({ method: 'tools/list' });
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
        expect(store.get({ method: 'tools/list' })).toBeUndefined();
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
        expect(store.get({ method: 'prompts/list' })).toBeDefined();
        expect(store.get({ method: 'resources/list' })).toBeDefined();
        expect(store.get({ method: 'resources/templates/list' })).toBeDefined();
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
        expect(store.get({ method: 'tools/list' })).toBeDefined();
        expect(await toolDef(client, 'a')).toBeDefined();

        const before = listCount();
        await serverTx.send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' } as JSONRPCMessage);
        // Evicted, not refetched.
        expect(store.get({ method: 'tools/list' })).toBeUndefined();
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
        expect(store.get({ method: 'resources/list' })).toBeDefined();
        expect(store.get({ method: 'resources/templates/list' })).toBeDefined();

        await serverTx.send({ jsonrpc: '2.0', method: 'notifications/resources/list_changed' } as JSONRPCMessage);
        expect(store.get({ method: 'resources/list' })).toBeUndefined();
        expect(store.get({ method: 'resources/templates/list' })).toBeUndefined();
    });

    it('_resetConnectionState leaves a user-supplied store untouched and drops the derived index', async () => {
        const store = new InMemoryResponseCacheStore();
        const { clientTx } = await scriptedModernServer([[TOOL_A]]);
        const client = modernClient(store);
        await client.connect(clientTx);
        await client.listTools();
        expect(store.get({ method: 'tools/list' })).toBeDefined();

        await client.close();
        // A user-supplied store is NOT cleared on close/reconnect (defeats the
        // only reason to supply one); the per-instance default IS cleared.
        expect(store.get({ method: 'tools/list' })).toBeDefined();
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

    it('a custom store whose evict() throws is routed to onerror and dispatch still runs', async () => {
        const store = new InMemoryResponseCacheStore();
        store.evict = () => {
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
