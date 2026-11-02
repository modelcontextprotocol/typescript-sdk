/**
 * Ordinary callTool compiles only the named tool's output schema.
 *
 * The stamp-keyed catalog stays complete. Validators for tools that are not
 * called are not compiled. A new list stamp, eviction, reconnect, or server
 * identity drops the memoized validator so a changed schema cannot be reused.
 */
import type { CallToolResult, JSONRPCMessage, JSONRPCRequest, JsonSchemaType, Tool } from '@modelcontextprotocol/core-internal';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION, ProtocolErrorCode } from '@modelcontextprotocol/core-internal';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it } from 'vitest';

import { Client } from '../../src/client/client';
import { ClientResponseCache, InMemoryResponseCacheStore } from '../../src/client/responseCache';

const MODERN = '2026-07-28';
const PRE = JSON.stringify(['', '']);
const FILLER_COUNT = 32;

const numberSchema = (id?: string): JsonSchemaType => ({
    ...(id !== undefined && { $id: id }),
    type: 'object',
    properties: { count: { type: 'number' } },
    required: ['count'],
    additionalProperties: false
});

const labelSchema = (id?: string): JsonSchemaType => ({
    ...(id !== undefined && { $id: id }),
    type: 'object',
    properties: { label: { type: 'string' } },
    required: ['label'],
    additionalProperties: false
});

const BAD_SCHEMA: JsonSchemaType = {
    $id: 'https://example.test/schemas/bad',
    type: 'object',
    $ref: 'https://example.invalid/missing.json'
};

function tool(name: string, outputSchema?: JsonSchemaType): Tool {
    return {
        name,
        inputSchema: { type: 'object' },
        ...(outputSchema !== undefined && { outputSchema })
    };
}

function fillers(count = FILLER_COUNT): Tool[] {
    return Array.from({ length: count }, (_, index) =>
        tool(`filler-${index}`, numberSchema(`https://example.test/schemas/filler-${index}`))
    );
}

interface CompileSpy {
    compiles: number;
    schemaHits: number;
    compileMs: number[];
    restore: () => void;
}

function spyAjvCompile(): CompileSpy {
    const spy: CompileSpy = { compiles: 0, schemaHits: 0, compileMs: [], restore: () => {} };
    const prototype = Ajv2020.prototype as unknown as {
        compile: (this: unknown, schema: unknown) => unknown;
        getSchema: (this: unknown, keyRef: string) => unknown;
    };
    const originalCompile = prototype.compile;
    const originalGetSchema = prototype.getSchema;
    prototype.compile = function (schema: unknown) {
        const started = performance.now();
        try {
            return originalCompile.call(this, schema);
        } finally {
            spy.compiles += 1;
            spy.compileMs.push(performance.now() - started);
        }
    };
    prototype.getSchema = function (keyRef: string) {
        const found = originalGetSchema.call(this, keyRef);
        if (found !== undefined) spy.schemaHits += 1;
        return found;
    };
    spy.restore = () => {
        prototype.compile = originalCompile;
        prototype.getSchema = originalGetSchema;
    };
    return spy;
}

describe('ClientResponseCache outputValidator lazy compile', () => {
    const listed = [tool('pick', numberSchema()), tool('bad', BAD_SCHEMA), tool('plain'), ...fillers(4)];

    async function cacheWith(tools: Tool[]): Promise<ClientResponseCache> {
        const store = new InMemoryResponseCacheStore();
        const cache = new ClientResponseCache(store, true);
        store.set({ method: 'tools/list', partition: PRE }, { value: JSON.stringify({ tools }) });
        return cache;
    }

    it('compiles only the requested name and memoizes it for the stamp', async () => {
        const cache = await cacheWith(listed);
        const seen: string[] = [];
        const compile = (entry: Tool) => {
            seen.push(entry.name);
            return entry.outputSchema === undefined ? undefined : { name: entry.name };
        };

        await expect(cache.outputValidator('pick', compile)).resolves.toEqual({ name: 'pick' });
        await expect(cache.outputValidator('pick', compile)).resolves.toEqual({ name: 'pick' });
        await expect(cache.outputValidator('plain', compile)).resolves.toBeUndefined();
        await expect(cache.outputValidator('plain', compile)).resolves.toBeUndefined();
        await expect(cache.outputValidator('missing', compile)).resolves.toBeUndefined();
        expect(seen).toEqual(['pick', 'plain']);
    });

    it('a new stamp drops the previous validator and compiles only the requested tool', async () => {
        const store = new InMemoryResponseCacheStore();
        const cache = new ClientResponseCache(store, true);
        store.set({ method: 'tools/list', partition: PRE }, { value: JSON.stringify({ tools: listed }) });
        const seen: string[] = [];
        const compile = (entry: Tool) => {
            seen.push(entry.name);
            return { schema: entry.outputSchema };
        };

        const first = await cache.outputValidator('pick', compile);
        store.set(
            { method: 'tools/list', partition: PRE },
            { value: JSON.stringify({ tools: [tool('pick', labelSchema()), ...fillers(4)] }) }
        );
        const second = await cache.outputValidator('pick', compile);
        expect(first).not.toBe(second);
        expect(second).toEqual({ schema: labelSchema() });
        expect(seen).toEqual(['pick', 'pick']);
    });

    it('does not memoize a throwing compile, and eviction clears a stored failure', async () => {
        const store = new InMemoryResponseCacheStore();
        const cache = new ClientResponseCache(store, true);
        store.set({ method: 'tools/list', partition: PRE }, { value: JSON.stringify({ tools: [tool('pick', numberSchema())] }) });
        let calls = 0;
        const compile = () => {
            calls += 1;
            if (calls === 1) throw new Error('transient');
            return { ok: true };
        };
        await expect(cache.outputValidator('pick', compile)).rejects.toThrow('transient');
        await expect(cache.outputValidator('pick', compile)).resolves.toEqual({ ok: true });
        expect(calls).toBe(2);

        await cache.evict('tools/list');
        await expect(cache.outputValidator('pick', compile)).resolves.toBeUndefined();
        expect(calls).toBe(2);
    });

    it('resetForReconnect drops memoized validators even when a user store keeps the document', async () => {
        const store = new InMemoryResponseCacheStore();
        const cache = new ClientResponseCache(store, true);
        store.set({ method: 'tools/list', partition: PRE }, { value: JSON.stringify({ tools: listed }) });
        let calls = 0;
        const compile = (entry: Tool) => {
            calls += 1;
            return entry.name;
        };
        await expect(cache.outputValidator('pick', compile)).resolves.toBe('pick');
        cache.resetForReconnect();
        store.set({ method: 'tools/list', partition: PRE }, { value: JSON.stringify({ tools: listed }) });
        await expect(cache.outputValidator('pick', compile)).resolves.toBe('pick');
        expect(calls).toBe(2);
    });
});

interface LegacyHarness {
    client: Client;
    calls: () => string[];
    close: () => Promise<void>;
}

function legacyClient(): Client {
    return new Client({ name: 'lazy-output-client', version: '1.0.0' }, { capabilities: {} });
}

async function connectLegacy(getTools: () => Tool[], onCall: (name: string) => CallToolResult): Promise<LegacyHarness> {
    const client = legacyClient();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const callNames: string[] = [];
    serverTransport.onmessage = async message => {
        if (!('method' in message) || !('id' in message)) return;
        if (message.method === 'initialize') {
            await serverTransport.send({
                jsonrpc: '2.0',
                id: message.id,
                result: {
                    protocolVersion: LATEST_PROTOCOL_VERSION,
                    capabilities: { tools: { listChanged: true } },
                    serverInfo: { name: 'lazy-fixture', version: '1.0.0' }
                }
            });
            return;
        }
        if (message.method === 'tools/list') {
            await serverTransport.send({
                jsonrpc: '2.0',
                id: message.id,
                result: { tools: getTools(), ttlMs: 0 }
            } satisfies JSONRPCMessage);
            return;
        }
        if (message.method === 'tools/call') {
            const name = (message.params as { name: string }).name;
            callNames.push(name);
            await serverTransport.send({
                jsonrpc: '2.0',
                id: message.id,
                result: onCall(name)
            } satisfies JSONRPCMessage);
        }
    };
    await Promise.all([client.connect(clientTransport), serverTransport.start()]);
    return {
        client,
        calls: () => callNames,
        close: async () => {
            await client.close();
            await clientTransport.close();
            await serverTransport.close();
        }
    };
}

describe('default Ajv callTool compiles only the named tool', () => {
    let spy: CompileSpy | undefined;

    afterEach(() => {
        spy?.restore();
        spy = undefined;
    });

    it('lists the full catalog, then engine.compile runs once for the called tool', async () => {
        spy = spyAjvCompile();
        const catalog = [tool('pick', numberSchema('https://example.test/schemas/pick')), tool('bad', BAD_SCHEMA), ...fillers()];
        const harness = await connectLegacy(
            () => catalog,
            () => ({ content: [{ type: 'text', text: 'ok' }], structuredContent: { count: 1 } })
        );

        const listed = await harness.client.listTools();
        expect(listed.tools).toHaveLength(catalog.length);
        expect(spy.compiles).toBe(0);

        const started = performance.now();
        await expect(harness.client.callTool({ name: 'pick', arguments: {} })).resolves.toMatchObject({
            structuredContent: { count: 1 }
        });
        const callMs = performance.now() - started;
        expect(spy.compiles).toBe(1);
        expect(spy.schemaHits).toBe(0);
        expect(callMs).toBeGreaterThanOrEqual(0);

        await harness.client.callTool({ name: 'pick', arguments: {} });
        expect(spy.compiles).toBe(1);
        await harness.close();
    });

    it('an uncalled bad schema does not compile or fail; the called bad schema fails before the request', async () => {
        spy = spyAjvCompile();
        const harness = await connectLegacy(
            () => [tool('pick', numberSchema()), tool('bad', BAD_SCHEMA), ...fillers()],
            () => ({ content: [], structuredContent: { count: 1 } })
        );
        await harness.client.listTools();
        await expect(harness.client.callTool({ name: 'pick', arguments: {} })).resolves.toMatchObject({
            structuredContent: { count: 1 }
        });
        expect(spy.compiles).toBe(1);
        expect(harness.calls()).toEqual(['pick']);

        await expect(harness.client.callTool({ name: 'bad', arguments: {} })).rejects.toThrow(/invalid outputSchema/);
        expect(harness.calls()).toEqual(['pick']);
        expect(spy.compiles).toBe(2);
        await harness.close();
    });

    it('a refreshed catalog with a changed output schema does not reuse the previous validator', async () => {
        spy = spyAjvCompile();
        let schema = numberSchema();
        const harness = await connectLegacy(
            () => [tool('pick', schema), ...fillers()],
            () => ({ content: [], structuredContent: { count: 1 } })
        );
        await harness.client.listTools();
        await harness.client.callTool({ name: 'pick', arguments: {} });
        expect(spy.compiles).toBe(1);

        schema = labelSchema();
        await harness.client.listTools();
        // Result validation runs after the response. The new schema rejects the
        // payload the previous validator accepted, and siblings stay uncompiled.
        await expect(harness.client.callTool({ name: 'pick', arguments: {} })).rejects.toThrow(/does not match the tool's output schema/);
        expect(spy.compiles).toBe(2);
        expect(harness.calls()).toEqual(['pick', 'pick']);
        await harness.close();
    });

    it('an unchanged content-bound id is not compiled again, and validation still runs', async () => {
        spy = spyAjvCompile();
        const schema = numberSchema('https://example.test/schemas/pick');
        let description = 'one';
        const harness = await connectLegacy(
            () => [{ ...tool('pick', schema), description }, ...fillers()],
            () => ({ content: [], structuredContent: { count: 1 } })
        );
        await harness.client.listTools();
        await harness.client.callTool({ name: 'pick', arguments: {} });
        description = 'two';
        await harness.client.listTools();
        await expect(harness.client.callTool({ name: 'pick', arguments: {} })).resolves.toMatchObject({
            structuredContent: { count: 1 }
        });
        expect(spy.compiles).toBe(1);
        expect(spy.schemaHits).toBe(1);
        await harness.client.callTool({ name: 'pick', arguments: {} });
        // Same stamp as the refreshed list: the memoized validator is reused.
        expect(spy.compiles).toBe(1);
        expect(spy.schemaHits).toBe(1);
        await harness.close();
    });

    it('list_changed drops the validator; listing the tool again restores validation', async () => {
        spy = spyAjvCompile();
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = legacyClient();
        let tools = [tool('pick', numberSchema()), ...fillers()];
        const callNames: string[] = [];
        serverTransport.onmessage = async message => {
            if (!('method' in message) || !('id' in message)) return;
            switch (message.method) {
                case 'initialize': {
                    await serverTransport.send({
                        jsonrpc: '2.0',
                        id: message.id,
                        result: {
                            protocolVersion: LATEST_PROTOCOL_VERSION,
                            capabilities: { tools: { listChanged: true } },
                            serverInfo: { name: 'lazy-fixture', version: '1.0.0' }
                        }
                    });

                    break;
                }
                case 'tools/list': {
                    await serverTransport.send({
                        jsonrpc: '2.0',
                        id: message.id,
                        result: { tools, ttlMs: 0 }
                    } satisfies JSONRPCMessage);

                    break;
                }
                case 'tools/call': {
                    callNames.push((message.params as { name: string }).name);
                    await serverTransport.send({
                        jsonrpc: '2.0',
                        id: message.id,
                        result: { content: [], structuredContent: { count: 1 } }
                    } satisfies JSONRPCMessage);

                    break;
                }
                // No default
            }
        };
        await Promise.all([client.connect(clientTransport), serverTransport.start()]);
        await client.listTools();
        await client.callTool({ name: 'pick', arguments: {} });
        expect(spy.compiles).toBe(1);

        await serverTransport.send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
        await client.callTool({ name: 'pick', arguments: {} });
        expect(spy.compiles).toBe(1);
        expect(callNames).toEqual(['pick', 'pick']);

        tools = [tool('pick', labelSchema()), ...fillers()];
        await client.listTools();
        await expect(client.callTool({ name: 'pick', arguments: {} })).rejects.toThrow(/does not match the tool's output schema/);
        expect(spy.compiles).toBe(2);
        expect(callNames).toEqual(['pick', 'pick', 'pick']);

        await client.close();
        await clientTransport.close();
        await serverTransport.close();
    });

    it('removing and re-enabling a tool follows the cached catalog', async () => {
        spy = spyAjvCompile();
        let tools: Tool[] = [tool('pick', numberSchema()), ...fillers()];
        const harness = await connectLegacy(
            () => tools,
            () => ({ content: [], structuredContent: { count: 1 } })
        );
        await harness.client.listTools();
        await harness.client.callTool({ name: 'pick', arguments: {} });

        tools = fillers();
        await harness.client.listTools();
        await harness.client.callTool({ name: 'pick', arguments: {} });
        expect(spy.compiles).toBe(1);

        tools = [tool('pick', labelSchema()), ...fillers()];
        await harness.client.listTools();
        await expect(harness.client.callTool({ name: 'pick', arguments: {} })).rejects.toThrow(/does not match the tool's output schema/);
        expect(spy.compiles).toBe(2);
        await harness.close();
    });

    it('mutating the toolDefinition object does not change the stored schema used for compilation', async () => {
        spy = spyAjvCompile();
        const harness = await connectLegacy(
            () => [tool('pick', numberSchema()), ...fillers()],
            () => ({ content: [], structuredContent: { count: 1 } })
        );
        await harness.client.listTools();
        const cache = (harness.client as unknown as { _cache: ClientResponseCache })._cache;
        const defined = await cache.toolDefinition('pick');
        defined!.outputSchema = labelSchema();
        await expect(harness.client.callTool({ name: 'pick', arguments: {} })).resolves.toMatchObject({
            structuredContent: { count: 1 }
        });
        expect(spy.compiles).toBe(1);
        await harness.close();
    });

    it('explicit toolDefinition compiles that definition only and does not warm the catalog', async () => {
        spy = spyAjvCompile();
        const body: { structuredContent: Record<string, unknown> } = { structuredContent: { label: 'direct' } };
        const harness = await connectLegacy(
            () => [tool('pick', numberSchema('https://example.test/schemas/pick')), tool('bad', BAD_SCHEMA), ...fillers()],
            () => ({ content: [], structuredContent: body.structuredContent })
        );
        await harness.client.listTools();
        expect(spy.compiles).toBe(0);
        await expect(
            harness.client.callTool(
                { name: 'pick', arguments: {} },
                { toolDefinition: tool('pick', labelSchema('https://example.test/schemas/direct')) }
            )
        ).resolves.toMatchObject({ structuredContent: { label: 'direct' } });
        expect(spy.compiles).toBe(1);
        expect(harness.calls()).toEqual(['pick']);

        body.structuredContent = { count: 1 };
        await expect(harness.client.callTool({ name: 'pick', arguments: {} })).resolves.toMatchObject({
            structuredContent: { count: 1 }
        });
        expect(spy.compiles).toBe(2);
        await harness.close();
    });

    it('reconnect and a different server do not reuse the previous validator', async () => {
        spy = spyAjvCompile();
        const client = legacyClient();
        const open = async (name: string, version: string, schema: JsonSchemaType) => {
            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            serverTransport.onmessage = async message => {
                if (!('method' in message) || !('id' in message)) return;
                switch (message.method) {
                    case 'initialize': {
                        await serverTransport.send({
                            jsonrpc: '2.0',
                            id: message.id,
                            result: {
                                protocolVersion: LATEST_PROTOCOL_VERSION,
                                capabilities: { tools: {} },
                                serverInfo: { name, version }
                            }
                        });

                        break;
                    }
                    case 'tools/list': {
                        await serverTransport.send({
                            jsonrpc: '2.0',
                            id: message.id,
                            result: { tools: [tool('pick', schema), ...fillers()], ttlMs: 0 }
                        } satisfies JSONRPCMessage);

                        break;
                    }
                    case 'tools/call': {
                        await serverTransport.send({
                            jsonrpc: '2.0',
                            id: message.id,
                            result: { content: [], structuredContent: { count: 1 } }
                        } satisfies JSONRPCMessage);

                        break;
                    }
                    // No default
                }
            };
            await Promise.all([client.connect(clientTransport), serverTransport.start()]);
            return { clientTransport, serverTransport };
        };

        const first = await open('server-a', '1', numberSchema());
        await client.listTools();
        await client.callTool({ name: 'pick', arguments: {} });
        expect(spy.compiles).toBe(1);
        await client.close();
        await first.clientTransport.close();
        await first.serverTransport.close();

        const second = await open('server-b', '2', labelSchema());
        await client.listTools();
        await expect(client.callTool({ name: 'pick', arguments: {} })).rejects.toThrow(/does not match the tool's output schema/);
        expect(spy.compiles).toBe(2);
        await client.close();
        await second.clientTransport.close();
        await second.serverTransport.close();
    });
});

describe('modern header mismatch refreshes only the called validator', () => {
    let spy: CompileSpy | undefined;

    afterEach(() => {
        spy?.restore();
        spy = undefined;
    });

    it('recompiles the named tool from the refreshed list and does not compile siblings', async () => {
        spy = spyAjvCompile();
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        let listRound = 0;
        let calls = 0;
        serverTransport.onmessage = message => {
            const request = message as JSONRPCRequest;
            if (request.id === undefined) return;
            if (request.method === 'server/discover') {
                void serverTransport.send({
                    jsonrpc: '2.0',
                    id: request.id,
                    result: {
                        resultType: 'complete',
                        supportedVersions: [MODERN],
                        capabilities: { tools: { listChanged: true } },
                        _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'header-fixture', version: '1.0.0' } }
                    }
                });
                return;
            }
            if (request.method === 'tools/list') {
                listRound += 1;
                const schema = listRound === 1 ? numberSchema() : labelSchema();
                void serverTransport.send({
                    jsonrpc: '2.0',
                    id: request.id,
                    result: {
                        resultType: 'complete',
                        ttlMs: 0,
                        cacheScope: 'private',
                        tools: [tool('pick', schema), tool('bad', BAD_SCHEMA), ...fillers()]
                    }
                });
                return;
            }
            if (request.method === 'tools/call') {
                calls += 1;
                if (calls === 1) {
                    void serverTransport.send({
                        jsonrpc: '2.0',
                        id: request.id,
                        error: { code: -32_020, message: 'Bad Request: the request headers and body disagree' }
                    });
                    return;
                }
                void serverTransport.send({
                    jsonrpc: '2.0',
                    id: request.id,
                    result: { resultType: 'complete', content: [], structuredContent: { label: 'refreshed' } }
                });
            }
        };
        await serverTransport.start();
        const client = new Client({ name: 'header-client', version: '1.0.0' }, { versionNegotiation: { mode: { pin: MODERN } } });
        await client.connect(clientTransport);
        await client.listTools();
        await expect(client.callTool({ name: 'pick', arguments: {} })).resolves.toMatchObject({
            structuredContent: { label: 'refreshed' }
        });
        expect(calls).toBe(2);
        expect(listRound).toBe(2);
        // First attempt compiles pick. The mismatch refetch compiles pick again
        // from the new document. The bad sibling and fillers stay uncompiled.
        expect(spy.compiles).toBe(2);
        await client.close();
        await clientTransport.close();
        await serverTransport.close();
    });
});

describe('compile error code', () => {
    it('uses InvalidParams for a called tool whose output schema cannot compile', async () => {
        const harness = await connectLegacy(
            () => [tool('bad', BAD_SCHEMA)],
            () => ({ content: [] })
        );
        await harness.client.listTools();
        await expect(harness.client.callTool({ name: 'bad', arguments: {} })).rejects.toMatchObject({
            code: ProtocolErrorCode.InvalidParams
        });
        expect(harness.calls()).toEqual([]);
        await harness.close();
    });
});

it('Root: absent caller names cannot grow the stamp cache beyond the declared catalog', async () => {
    const store = new InMemoryResponseCacheStore();
    const cache = new ClientResponseCache(store, true);
    store.set({ method: 'tools/list', partition: PRE }, { value: JSON.stringify({ tools: [tool('pick', numberSchema())] }) });
    let compiled = 0;
    const compile = () => {
        compiled += 1;
        return { ok: true };
    };
    for (let i = 0; i < 1024; i += 1) await expect(cache.outputValidator(`absent-${i}`, compile)).resolves.toBeUndefined();
    const index = (cache as unknown as { _toolOutputValidatorIndex: { byName: Map<string, unknown> } })._toolOutputValidatorIndex;
    expect(compiled).toBe(0);
    expect(index.byName.size).toBe(0);
    await cache.outputValidator('pick', compile);
    expect(compiled).toBe(1);
    expect(index.byName.size).toBe(1);
});
