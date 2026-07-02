import type { JSONRPCMessage, JsonSchemaType, JsonSchemaValidatorResult, jsonSchemaValidator } from '@modelcontextprotocol/core-internal';
import { InMemoryTransport, LATEST_LEGACY_PROTOCOL_VERSION } from '@modelcontextprotocol/core-internal';
import { Client } from '../../src/client/client';
import { fromJsonSchema } from '../../src/fromJsonSchema';

class RecordingValidator implements jsonSchemaValidator {
    schemas: JsonSchemaType[] = [];
    values: unknown[] = [];

    getValidator<T>(schema: JsonSchemaType) {
        this.schemas.push(schema);
        return (value: unknown): JsonSchemaValidatorResult<T> => {
            this.values.push(value);
            return { valid: true, data: value as T, errorMessage: undefined };
        };
    }
}

async function connectInitializedClient(client: Client) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    serverTransport.onmessage = async message => {
        if ('method' in message && 'id' in message && message.method === 'initialize') {
            await serverTransport.send({
                jsonrpc: '2.0',
                id: message.id,
                result: {
                    protocolVersion: LATEST_LEGACY_PROTOCOL_VERSION,
                    capabilities: { tools: {} },
                    serverInfo: { name: 'test-server', version: '1.0.0' }
                }
            });
        } else if ('method' in message && 'id' in message && message.method === 'tools/list') {
            await serverTransport.send({
                jsonrpc: '2.0',
                id: message.id,
                result: {
                    tools: [
                        {
                            name: 'structured-tool',
                            description: 'A tool with structured output',
                            inputSchema: { type: 'object' },
                            outputSchema: {
                                type: 'object',
                                properties: { count: { type: 'number' } },
                                required: ['count']
                            }
                        }
                    ]
                }
            } satisfies JSONRPCMessage);
        } else if ('method' in message && 'id' in message && message.method === 'tools/call') {
            await serverTransport.send({
                jsonrpc: '2.0',
                id: message.id,
                result: { content: [], structuredContent: { count: 42 } }
            } satisfies JSONRPCMessage);
        }
    };

    await Promise.all([client.connect(clientTransport), serverTransport.start()]);
    return { clientTransport, serverTransport };
}

describe('client JSON Schema validator overrides', () => {
    test('Client uses the custom validator for tool output validation (derived from the cached tools/list entry)', async () => {
        const validator = new RecordingValidator();
        const client = new Client(
            { name: 'test-client', version: '1.0.0' },
            {
                capabilities: {},
                jsonSchemaValidator: validator
            }
        );
        const { clientTransport, serverTransport } = await connectInitializedClient(client);

        // The validator index reads the cached `tools/list` entry; populate it
        // via the public auto-aggregating listTools().
        await expect(client.listTools()).resolves.toMatchObject({
            tools: [
                {
                    name: 'structured-tool',
                    outputSchema: {
                        type: 'object',
                        properties: { count: { type: 'number' } },
                        required: ['count']
                    }
                }
            ]
        });

        // Derived-view behavior: the validator index re-derives lazily on the
        // first callTool against the cached entry's stamp — populating the
        // cache alone does not compile.
        expect(validator.schemas).toEqual([]);

        await expect(client.callTool({ name: 'structured-tool' })).resolves.toMatchObject({
            structuredContent: { count: 42 }
        });
        expect(validator.schemas).toEqual([
            {
                type: 'object',
                properties: { count: { type: 'number' } },
                required: ['count']
            }
        ]);
        expect(validator.values).toEqual([{ count: 42 }]);

        // Same backing entry stamp → memoized; a second callTool does not recompile.
        await client.callTool({ name: 'structured-tool' });
        expect(validator.schemas).toHaveLength(1);

        await client.close();
        await clientTransport.close();
        await serverTransport.close();
    });

    describe('outputSchema compile-error lifecycle (substrate-held; no parallel map)', () => {
        // SEP-2106 §invalid-outputSchema: a tool whose outputSchema fails to compile is
        // surfaced as a typed InvalidParams BEFORE the request is sent. The compile error is
        // held on the response-cache substrate's stamp-keyed `name → validator` index, so it
        // inherits that substrate's invalidation lifecycle — a refetched `tools/list` re-derives
        // it from scratch (no stale-entry bug when the server fixes the tool by removing the
        // schema). The caller-supplied `toolDefinition` path is compiled in isolation and never
        // touches the cache, so a one-off bad definition cannot poison the listed tool.
        async function connectMutableToolsClient(getTools: () => unknown[]) {
            const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            serverTransport.onmessage = async message => {
                if (!('method' in message) || !('id' in message)) return;
                if (message.method === 'initialize') {
                    await serverTransport.send({
                        jsonrpc: '2.0',
                        id: message.id,
                        result: {
                            protocolVersion: LATEST_LEGACY_PROTOCOL_VERSION,
                            capabilities: { tools: {} },
                            serverInfo: { name: 'test-server', version: '1.0.0' }
                        }
                    });
                } else if (message.method === 'tools/list') {
                    await serverTransport.send({
                        jsonrpc: '2.0',
                        id: message.id,
                        result: { tools: getTools() }
                    } satisfies JSONRPCMessage);
                } else if (message.method === 'tools/call') {
                    await serverTransport.send({
                        jsonrpc: '2.0',
                        id: message.id,
                        result: { content: [{ type: 'text', text: 'ok' }], structuredContent: { count: 1 } }
                    } satisfies JSONRPCMessage);
                }
            };
            await Promise.all([client.connect(clientTransport), serverTransport.start()]);
            return { client, close: () => Promise.all([client.close(), clientTransport.close(), serverTransport.close()]) };
        }

        // An external `$ref` throws at compile time inside Ajv (MissingRefError — no fetch is
        // attempted) and is captured per-tool by `_compileOutputValidator`.
        const BAD_SCHEMA = { type: 'object', $ref: 'https://example.invalid/schema.json' } as const;
        const GOOD_SCHEMA = { type: 'object', properties: { count: { type: 'number' } } } as const;

        test('re-advertising a tool WITHOUT the bad outputSchema clears the captured failure', async () => {
            let tools: unknown[] = [{ name: 't', inputSchema: { type: 'object' }, outputSchema: BAD_SCHEMA }];
            const { client, close } = await connectMutableToolsClient(() => tools);

            await client.listTools();
            await expect(client.callTool({ name: 't' })).rejects.toThrow(/invalid outputSchema/);

            // Server fixes the tool by removing outputSchema entirely; refetched `tools/list`
            // re-derives the index from scratch — no stale compile-error entry survives.
            tools = [{ name: 't', inputSchema: { type: 'object' } }];
            await client.listTools();
            await expect(client.callTool({ name: 't' })).resolves.toMatchObject({
                content: [{ type: 'text', text: 'ok' }]
            });

            await close();
        });

        test('a one-off `toolDefinition` with a bad outputSchema does not poison the listed tool', async () => {
            const tools: unknown[] = [{ name: 't', inputSchema: { type: 'object' }, outputSchema: GOOD_SCHEMA }];
            const { client, close } = await connectMutableToolsClient(() => tools);

            await client.listTools();
            await expect(
                client.callTool({ name: 't' }, { toolDefinition: { name: 't', inputSchema: { type: 'object' }, outputSchema: BAD_SCHEMA } })
            ).rejects.toThrow(/invalid outputSchema/);

            // Subsequent plain callTool of the same name (against the cached, valid listed
            // schema) succeeds — the one-off definition never entered the cache.
            await expect(client.callTool({ name: 't' })).resolves.toMatchObject({
                structuredContent: { count: 1 }
            });

            await close();
        });
    });

    test('fromJsonSchema uses an explicitly supplied custom validator', async () => {
        const validator = new RecordingValidator();
        const schema: JsonSchemaType = {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name']
        };

        const standardSchema = fromJsonSchema<{ name: string }>(schema, validator);
        expect(standardSchema['~standard'].validate({ name: 123 })).toEqual({ value: { name: 123 } });

        expect(validator.schemas).toEqual([schema]);
        expect(validator.values).toEqual([{ name: 123 }]);
    });
});
