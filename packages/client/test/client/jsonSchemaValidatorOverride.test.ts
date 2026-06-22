import type { JSONRPCMessage, JsonSchemaType, JsonSchemaValidatorResult, jsonSchemaValidator } from '@modelcontextprotocol/core';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/core';
import { Client } from '../../src/client/client.js';
import { fromJsonSchema } from '../../src/fromJsonSchema.js';

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
                    protocolVersion: LATEST_PROTOCOL_VERSION,
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
