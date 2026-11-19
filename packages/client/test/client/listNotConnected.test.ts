import type { JSONRPCRequest, ServerCapabilities } from '@modelcontextprotocol/core-internal';
import { InMemoryTransport } from '@modelcontextprotocol/core-internal';
import { describe, expect, it } from 'vitest';

import { Client } from '../../src/client/client';
import type { CacheKey, ResponseCacheStore } from '../../src/client/responseCache';
import { InMemoryResponseCacheStore } from '../../src/client/responseCache';

const MODERN = '2026-07-28';
const LEGACY = '2025-11-25';
const PRE_CONNECT_PARTITION = JSON.stringify(['', '']);

const LIST_RESULTS: Record<string, Record<string, unknown>> = {
    'tools/list': { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] },
    'prompts/list': { prompts: [{ name: 'greet' }] },
    'resources/list': { resources: [{ uri: 'file:///a', name: 'a' }] },
    'resources/templates/list': { resourceTemplates: [{ uriTemplate: 'file:///{name}', name: 'tmpl' }] }
};

interface PairOptions {
    capabilities?: ServerCapabilities;
    listTtlMs?: number;
    modern?: boolean;
    responseCacheStore?: ResponseCacheStore;
}

async function connectedPair(opts: PairOptions = {}) {
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const wireCounts = new Map<string, number>();
    const capabilities = opts.capabilities ?? {};
    const modern = opts.modern ?? false;

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
                    capabilities,
                    _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'scripted', version: '1.0.0' } }
                }
            });
        } else if (r.method === 'initialize') {
            void serverTx.send({
                jsonrpc: '2.0',
                id: r.id,
                result: {
                    protocolVersion: LEGACY,
                    capabilities,
                    serverInfo: { name: 'scripted', version: '1.0.0' }
                }
            });
        } else if (Object.hasOwn(LIST_RESULTS, r.method)) {
            const modernMeta = modern ? { resultType: 'complete', ttlMs: opts.listTtlMs ?? 0, cacheScope: 'public' } : {};
            void serverTx.send({
                jsonrpc: '2.0',
                id: r.id,
                result: { ...modernMeta, ...LIST_RESULTS[r.method] }
            });
        }
    };

    await serverTx.start();
    const client = new Client(
        { name: 'test-client', version: '1.0.0' },
        {
            ...(modern && { versionNegotiation: { mode: { pin: MODERN } } }),
            ...(opts.responseCacheStore && { responseCacheStore: opts.responseCacheStore })
        }
    );
    await client.connect(clientTx);
    const server = { close: () => serverTx.close() };
    return { client, server, wireCount: (method: string) => wireCounts.get(method) ?? 0 };
}

function createSpyCacheStore() {
    const store = new InMemoryResponseCacheStore();
    const getCalls: CacheKey[] = [];
    const realGet = store.get.bind(store);
    (store as ResponseCacheStore).get = key => {
        getCalls.push(key);
        return realGet(key);
    };
    return { store, getCalls };
}

function seedFreshListEntries(store: InMemoryResponseCacheStore, partition: string): void {
    const expiresAt = Date.now() + 60_000;
    const entries: Array<[string, Record<string, unknown>]> = [
        ['tools/list', { tools: [{ name: 'cached-tool', inputSchema: { type: 'object' } }] }],
        ['prompts/list', { prompts: [{ name: 'cached-prompt' }] }],
        ['resources/list', { resources: [{ uri: 'file:///cached', name: 'cached' }] }],
        ['resources/templates/list', { resourceTemplates: [{ uriTemplate: 'file:///{cached}', name: 'cached' }] }]
    ];
    for (const [method, payload] of entries) {
        store.set({ method, params: '', partition }, { value: JSON.stringify(payload), expiresAt, scope: 'public' });
    }
}

async function expectAllListMethodsNotConnected(client: Client): Promise<void> {
    await expect(client.listTools()).rejects.toMatchObject({ message: 'Not connected' });
    await expect(client.listPrompts()).rejects.toMatchObject({ message: 'Not connected' });
    await expect(client.listResources()).rejects.toMatchObject({ message: 'Not connected' });
    await expect(client.listResourceTemplates()).rejects.toMatchObject({ message: 'Not connected' });
}

describe('Client list methods when disconnected (#3195)', () => {
    it('rejects all four capability-lenient list methods before connect', async () => {
        const client = new Client({ name: 'test-client', version: '1.0.0' });

        await expect(client.listTools()).rejects.toThrow('Not connected');
        await expect(client.listPrompts()).rejects.toThrow('Not connected');
        await expect(client.listResources()).rejects.toThrow('Not connected');
        await expect(client.listResourceTemplates()).rejects.toThrow('Not connected');
    });

    it('rejects all four list methods with Not connected after close()', async () => {
        const { client, server } = await connectedPair({
            capabilities: {
                tools: {},
                prompts: {},
                resources: {}
            }
        });

        await expect(client.listTools()).resolves.toMatchObject({ tools: [{ name: 'echo' }] });
        await expect(client.listPrompts()).resolves.toMatchObject({ prompts: [{ name: 'greet' }] });
        await expect(client.listResources()).resolves.toMatchObject({ resources: [{ name: 'a' }] });
        await expect(client.listResourceTemplates()).resolves.toMatchObject({ resourceTemplates: [{ name: 'tmpl' }] });

        await client.close();
        await expectAllListMethodsNotConnected(client);
        await server.close();
    });

    it('still returns empty lists when connected to a server without the capability', async () => {
        const { client, server } = await connectedPair();

        await expect(client.listTools()).resolves.toEqual({ tools: [] });
        await expect(client.listPrompts()).resolves.toEqual({ prompts: [] });
        await expect(client.listResources()).resolves.toEqual({ resources: [] });
        await expect(client.listResourceTemplates()).resolves.toEqual({ resourceTemplates: [] });

        await client.close();
        await server.close();
    });

    it('fails with Not connected before consulting responseCacheStore before connect()', async () => {
        const { store, getCalls } = createSpyCacheStore();
        seedFreshListEntries(store, PRE_CONNECT_PARTITION);
        const client = new Client({ name: 'cached-client', version: '1.0.0' }, { responseCacheStore: store });

        await expectAllListMethodsNotConnected(client);
        expect(getCalls).toEqual([]);
    });

    it('fails with Not connected before consulting responseCacheStore after close()', async () => {
        const { store, getCalls } = createSpyCacheStore();
        const { client, server, wireCount } = await connectedPair({
            modern: true,
            listTtlMs: 60_000,
            capabilities: {
                tools: {},
                prompts: {},
                resources: {}
            },
            responseCacheStore: store
        });

        await client.listTools();
        await client.listPrompts();
        await client.listResources();
        await client.listResourceTemplates();

        // Confirm all four list verbs are actively served from cache while connected.
        await client.listTools();
        await client.listPrompts();
        await client.listResources();
        await client.listResourceTemplates();
        expect(wireCount('tools/list')).toBe(1);
        expect(wireCount('prompts/list')).toBe(1);
        expect(wireCount('resources/list')).toBe(1);
        expect(wireCount('resources/templates/list')).toBe(1);

        await client.close();

        // Seed the pre-connect/post-reset sentinel partition as well: close() calls
        // resetForReconnect() (clearing server identity to ''), so without this and
        // the store.get spy a cache lookup before the transport check would miss on
        // the server partition and mask an ordering regression.
        seedFreshListEntries(store, PRE_CONNECT_PARTITION);
        getCalls.length = 0;

        await expectAllListMethodsNotConnected(client);
        expect(getCalls).toEqual([]);
        await server.close();
    });

    it('fails with Not connected before consulting responseCacheStore after remote transport close', async () => {
        const { store, getCalls } = createSpyCacheStore();
        const { client, server } = await connectedPair({
            modern: true,
            listTtlMs: 60_000,
            capabilities: {
                tools: {},
                prompts: {},
                resources: {}
            },
            responseCacheStore: store
        });

        await client.listTools();
        await client.listPrompts();
        await client.listResources();
        await client.listResourceTemplates();

        // Remote close clears client.transport via _onclose() without running
        // resetForReconnect(), leaving the server's cached entries addressable.
        await server.close();
        getCalls.length = 0;

        await expectAllListMethodsNotConnected(client);
        expect(getCalls).toEqual([]);
    });
});
