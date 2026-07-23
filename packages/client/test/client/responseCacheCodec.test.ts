import type { JSONRPCRequest } from '@modelcontextprotocol/core-internal';
import { InMemoryTransport } from '@modelcontextprotocol/core-internal';
import { afterEach, describe, expect, test } from 'vitest';
import { Client } from '../../src/client/client';
import type { CacheEntry, CacheKey, ResponseCacheStore } from '../../src/client/responseCache';
import { ClientResponseCache, InMemoryResponseCacheStore } from '../../src/client/responseCache';

const savedStructuredClone = globalThis.structuredClone;

afterEach(() => {
    globalThis.structuredClone = savedStructuredClone;
});

// Scripted server over a raw linked transport pair (the sibling
// responseCache.test.ts pattern) — the client package's tests must not
// depend on @modelcontextprotocol/server.
async function connectedPair() {
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    serverTx.onmessage = m => {
        const r = m as JSONRPCRequest;
        if (r.id === undefined) return;
        if (r.method === 'server/discover') {
            void serverTx.send({
                jsonrpc: '2.0',
                id: r.id,
                result: {
                    resultType: 'complete',
                    supportedVersions: ['2026-07-28'],
                    capabilities: { tools: {} },
                    _meta: { 'io.modelcontextprotocol/serverInfo': { name: 's', version: '1.0.0' } }
                }
            });
        } else if (r.method === 'tools/list') {
            void serverTx.send({
                jsonrpc: '2.0',
                id: r.id,
                result: {
                    resultType: 'complete',
                    ttlMs: 60_000,
                    cacheScope: 'private',
                    tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }]
                }
            });
        }
    };
    await serverTx.start();
    const client = new Client({ name: 'c', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    await client.connect(clientTx);
    const server = { close: () => serverTx.close() };
    return { client, server };
}

describe('response cache document codec', () => {
    test('the cache does not depend on structuredClone existing (jest-jsdom / Node < 17)', async () => {
        // Pre-codec, both cache edges called the global: environments without
        // it threw every write into the store-error swallow, silently
        // disabling caching. The codec (JSON round-trip) has no environment
        // dependency; this pins that the global is never required again.
        // @ts-expect-error simulating environments without the global
        delete globalThis.structuredClone;

        const { client, server } = await connectedPair();
        const errors: unknown[] = [];
        client.onerror = e => errors.push(e);
        const first = await client.listTools();
        const second = await client.listTools();
        expect(first.tools.map(t => t.name)).toEqual(['echo']);
        expect(second.tools.map(t => t.name)).toEqual(['echo']);
        expect(errors).toEqual([]);
        await client.close();
        await server.close();
    });

    test('served results are caller-owned: mutating one hit cannot reach the next', async () => {
        const { client, server } = await connectedPair();
        const first = await client.listTools();
        first.tools.length = 0;
        const second = await client.listTools();
        expect(second.tools.map(t => t.name)).toEqual(['echo']);
        await client.close();
        await server.close();
    });

    test('custom stores receive the serialized document, not a live object graph', async () => {
        const seen: unknown[] = [];
        const store = new InMemoryResponseCacheStore();
        const originalSet = store.set.bind(store);
        store.set = (key, entry) => {
            seen.push(entry.value);
            return originalSet(key, entry);
        };
        const cache = new ClientResponseCache(store, true);
        await cache.write(
            'tools/list',
            { tools: [{ name: 'a', inputSchema: { type: 'object' } }] },
            cache.captureGeneration('tools/list'),
            {
                expiresAt: Date.now() + 60_000,
                scope: 'private'
            }
        );
        expect(seen).toHaveLength(1);
        expect(typeof seen[0]).toBe('string');
        expect(JSON.parse(seen[0] as string).tools[0].name).toBe('a');
    });

    test('a non-JSON-serializable value fails the write loudly and does not poison later calls', async () => {
        const reported: unknown[] = [];
        const store = new InMemoryResponseCacheStore();
        const cache = new ClientResponseCache(store, true, error => reported.push(error));
        const cyclic: { tools: unknown[]; self?: unknown } = { tools: [] };
        cyclic.self = cyclic;

        await cache.write('tools/list', cyclic, cache.captureGeneration('tools/list'), {
            expiresAt: Date.now() + 60_000,
            scope: 'private'
        });
        // Reported (TypeError naming the cause), nothing stored, read is a miss.
        expect(reported).toHaveLength(1);
        expect(String(reported[0])).toMatch(/not JSON-serializable/);
        expect(await cache.read('tools/list')).toBeUndefined();

        // The cache stays functional for well-formed values afterwards.
        await cache.write(
            'tools/list',
            { tools: [{ name: 'b', inputSchema: { type: 'object' } }] },
            cache.captureGeneration('tools/list'),
            {
                expiresAt: Date.now() + 60_000,
                scope: 'private'
            }
        );
        expect(((await cache.read('tools/list'))?.value as { tools: { name: string }[] }).tools[0]?.name).toBe('b');
    });

    test('a corrupted document in an external store reads as a miss, not a crash', async () => {
        const reported: unknown[] = [];
        const store: ResponseCacheStore = {
            get: () => ({ value: '{ definitely not json', stamp: 1, expiresAt: Date.now() + 60_000, scope: 'private' as const }),
            set: () => 1,
            delete: () => {},
            evict: () => {},
            clear: () => {}
        };
        const cache = new ClientResponseCache(store, true, error => reported.push(error));
        expect(await cache.read('tools/list')).toBeUndefined();
        expect(await cache.toolDefinition('a')).toBeUndefined();
        expect(reported.length).toBeGreaterThan(0);
    });

    test('a value JSON.stringify silently cannot represent (top-level undefined) fails the write loudly, not as a stored "undefined"', async () => {
        const reported: unknown[] = [];
        const sets: unknown[] = [];
        const store = new InMemoryResponseCacheStore();
        const originalSet = store.set.bind(store);
        store.set = (key, entry) => {
            sets.push(entry.value);
            return originalSet(key, entry);
        };
        const cache = new ClientResponseCache(store, true, error => reported.push(error));
        await cache.write('tools/list', undefined, cache.captureGeneration('tools/list'), {
            expiresAt: Date.now() + 60_000,
            scope: 'private'
        });
        expect(reported).toHaveLength(1);
        expect(String(reported[0])).toMatch(/not JSON-serializable/);
        expect(sets).toHaveLength(0);
        expect(await cache.read('tools/list')).toBeUndefined();
    });

    test('a fresh undecodable entry is dropped on read, so it is reported once, not on every read until expiry', async () => {
        const reported: unknown[] = [];
        const deletes: CacheKey[] = [];
        let entry: CacheEntry | undefined = { value: '{ not json', stamp: 1, expiresAt: Date.now() + 60_000, scope: 'private' };
        const store: ResponseCacheStore = {
            get: () => entry,
            set: () => 1,
            delete: key => {
                deletes.push(key);
                entry = undefined;
            },
            evict: () => {},
            clear: () => {}
        };
        const cache = new ClientResponseCache(store, true, error => reported.push(error));
        expect(await cache.read('resources/read', 'file:///a')).toBeUndefined();
        expect(reported).toHaveLength(1);
        expect(deletes.length).toBeGreaterThan(0);
        expect(deletes[0]).toMatchObject({ method: 'resources/read', params: 'file:///a' });
        // Entry gone: the next read is a clean miss, no second report.
        expect(await cache.read('resources/read', 'file:///a')).toBeUndefined();
        expect(reported).toHaveLength(1);
    });

    test('a valid-JSON but wrong-shape tools/list document is reported once per stamp and treated as absent, not thrown', async () => {
        for (const document of ['null', '{}', '[]']) {
            const reported: unknown[] = [];
            const store: ResponseCacheStore = {
                get: () => ({ value: document, stamp: 7, scope: 'private' as const }),
                set: () => 1,
                delete: () => {},
                evict: () => {},
                clear: () => {}
            };
            const cache = new ClientResponseCache(store, true, error => reported.push(error));
            await expect(cache.toolDefinition('a')).resolves.toBeUndefined();
            await expect(cache.toolDefinition('a')).resolves.toBeUndefined();
            await expect(cache.outputValidator('a', () => undefined)).resolves.toBeUndefined();
            // Memoized against the unchanged stamp: one report for the tool
            // index, one for the validator index — not one per lookup.
            expect(reported).toHaveLength(2);
            expect(String(reported[0])).toMatch(/tools array/);
        }
    });

    test('a NaN expiresAt is never fresh: the entry is not served at any clock value', async () => {
        const store: ResponseCacheStore = {
            get: () => ({ value: '{"tools":[]}', stamp: 1, expiresAt: NaN, scope: 'private' as const }),
            set: () => 1,
            delete: () => {},
            evict: () => {},
            clear: () => {}
        };
        const cache = new ClientResponseCache(store, true);
        expect(await cache.read('tools/list')).toBeUndefined();
    });

    test('a fresh decodable-but-non-object document is reported, dropped, and read as a miss', async () => {
        for (const document of ['null', '"str"', '[]']) {
            const reported: unknown[] = [];
            const deletes: CacheKey[] = [];
            let entry: CacheEntry | undefined = { value: document, stamp: 1, expiresAt: Date.now() + 60_000, scope: 'private' };
            const store: ResponseCacheStore = {
                get: () => entry,
                set: () => 1,
                delete: key => {
                    deletes.push(key);
                    entry = undefined;
                },
                evict: () => {},
                clear: () => {}
            };
            const cache = new ClientResponseCache(store, true, error => reported.push(error));
            expect(await cache.read('tools/list')).toBeUndefined();
            expect(reported).toHaveLength(1);
            expect(String(reported[0])).toMatch(/not an object/);
            expect(deletes.length).toBeGreaterThan(0);
        }
    });

    test('a corrupt own-partition entry deletes only the probed partition, not the shared sibling', async () => {
        const reported: unknown[] = [];
        const gets: string[] = [];
        const deletes: string[] = [];
        const store: ResponseCacheStore = {
            // Own probe (first get) hits a corrupt entry; the shared partition is never touched.
            get: key => {
                gets.push(key.partition ?? '');
                return { value: '{ not json', stamp: 1, expiresAt: Date.now() + 60_000, scope: 'private' as const };
            },
            set: () => 1,
            delete: key => {
                deletes.push(key.partition ?? '');
            },
            evict: () => {},
            clear: () => {}
        };
        // Non-empty cachePartition: own !== shared, so a two-partition delete
        // (the pre-fix behavior) would be observable as a second delete.
        const cache = new ClientResponseCache(store, true, error => reported.push(error), 'alice');
        expect(await cache.read('tools/list')).toBeUndefined();
        expect(reported).toHaveLength(1);
        expect(gets).toHaveLength(1);
        expect(deletes).toEqual([gets[0]]);
        expect(gets[0]).toContain('alice');
    });

    test('a failing store delete during corrupt-entry cleanup is reported, not thrown to the caller', async () => {
        const reported: unknown[] = [];
        const store: ResponseCacheStore = {
            get: () => ({ value: '{ not json', stamp: 1, expiresAt: Date.now() + 60_000, scope: 'private' as const }),
            set: () => 1,
            delete: () => {
                throw new Error('store connection lost');
            },
            evict: () => {},
            clear: () => {}
        };
        const cache = new ClientResponseCache(store, true, error => reported.push(error));
        await expect(cache.read('tools/list')).resolves.toBeUndefined();
        expect(reported).toHaveLength(2);
        expect(String(reported[1])).toMatch(/connection lost/);
    });

    test('a tools/list document with non-object elements is reported once per stamp, not thrown per lookup', async () => {
        const reported: unknown[] = [];
        const store: ResponseCacheStore = {
            get: () => ({ value: '{"tools":[null]}', stamp: 9, scope: 'private' as const }),
            set: () => 1,
            delete: () => {},
            evict: () => {},
            clear: () => {}
        };
        const cache = new ClientResponseCache(store, true, error => reported.push(error));
        await expect(cache.toolDefinition('a')).resolves.toBeUndefined();
        await expect(cache.toolDefinition('a')).resolves.toBeUndefined();
        await expect(cache.outputValidator('a', () => undefined)).resolves.toBeUndefined();
        expect(reported).toHaveLength(2);
        expect(String(reported[0])).toMatch(/malformed tools array/);
    });
});
