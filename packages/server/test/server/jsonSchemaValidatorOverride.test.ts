import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/core-internal';
import { expectTypeOf } from 'vitest';
import * as z from 'zod/v4';
import type {
    ElicitInputFormParams,
    ElicitInputResult,
    JsonSchemaType,
    JsonSchemaValidatorResult,
    jsonSchemaValidator
} from '../../src/index';
import { fromJsonSchema } from '../../src/fromJsonSchema';
import { Server } from '../../src/server/server';

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

describe('server JSON Schema validator overrides', () => {
    test('Server constructor uses a custom validator for elicitation response validation', async () => {
        const validator = new RecordingValidator();
        const server = new Server(
            { name: 'test-server', version: '1.0.0' },
            {
                capabilities: {},
                jsonSchemaValidator: validator
            }
        );

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        await clientTransport.start();

        const initializeResponse = new Promise(resolve => {
            clientTransport.onmessage = message => resolve(message);
        });
        await clientTransport.send({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: LATEST_PROTOCOL_VERSION,
                capabilities: { elicitation: { form: {} } },
                clientInfo: { name: 'test-client', version: '1.0.0' }
            }
        });
        await initializeResponse;

        clientTransport.onmessage = async message => {
            if ('method' in message && 'id' in message && message.method === 'elicitation/create') {
                await clientTransport.send({
                    jsonrpc: '2.0',
                    id: message.id,
                    result: { action: 'accept', content: { name: 123 } }
                });
            }
        };

        await expect(
            server.elicitInput({
                message: 'What is your name?',
                requestedSchema: {
                    type: 'object',
                    properties: { name: { type: 'string' } },
                    required: ['name']
                }
            })
        ).resolves.toEqual({ action: 'accept', content: { name: 123 } });

        expect(validator.schemas).toEqual([
            {
                type: 'object',
                properties: { name: { type: 'string' } },
                required: ['name']
            }
        ]);
        expect(validator.values).toEqual([{ name: 123 }]);

        await server.close();
        await clientTransport.close();
    });

    test('Server elicitInput accepts a Standard Schema requestedSchema', async () => {
        const validator = new RecordingValidator();
        const server = new Server(
            { name: 'test-server', version: '1.0.0' },
            {
                capabilities: {},
                jsonSchemaValidator: validator
            }
        );

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        await clientTransport.start();

        const initializeResponse = new Promise(resolve => {
            clientTransport.onmessage = message => resolve(message);
        });
        await clientTransport.send({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: LATEST_PROTOCOL_VERSION,
                capabilities: { elicitation: { form: {} } },
                clientInfo: { name: 'test-client', version: '1.0.0' }
            }
        });
        await initializeResponse;

        let requestedSchema: JsonSchemaType | undefined;
        clientTransport.onmessage = async message => {
            if ('method' in message && 'id' in message && message.method === 'elicitation/create' && message.params) {
                requestedSchema = message.params.requestedSchema as JsonSchemaType;
                await clientTransport.send({
                    jsonrpc: '2.0',
                    id: message.id,
                    result: { action: 'accept', content: { count: '5' } }
                });
            }
        };

        const schema = z.object({
            count: z.coerce.number().min(1).meta({ title: 'Registration Count', description: 'Number of registrations to process' }),
            newsletter: z.boolean().default(false)
        });

        const params = {
            message: 'How many registrations?',
            requestedSchema: schema
        } satisfies ElicitInputFormParams<typeof schema>;

        const result = await server.elicitInput(params);

        expectTypeOf(result).toMatchTypeOf<ElicitInputResult<typeof schema>>();
        expectTypeOf(result.content).toEqualTypeOf<{ count: number; newsletter: boolean } | undefined>();
        expect(result).toEqual({ action: 'accept', content: { count: 5, newsletter: false } });
        expect(requestedSchema).toMatchObject({
            type: 'object',
            properties: {
                count: {
                    type: 'number',
                    minimum: 1,
                    title: 'Registration Count',
                    description: 'Number of registrations to process'
                },
                newsletter: { type: 'boolean', default: false }
            },
            required: ['count']
        });
        expect(validator.schemas).toEqual([]);
        expect(validator.values).toEqual([]);

        await server.close();
        await clientTransport.close();
    });

    test('Server elicitInput rejects Standard Schemas outside the elicitation subset before sending', async () => {
        const server = new Server({ name: 'test-server', version: '1.0.0' }, { capabilities: {} });

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        await clientTransport.start();

        const initializeResponse = new Promise(resolve => {
            clientTransport.onmessage = message => resolve(message);
        });
        await clientTransport.send({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: LATEST_PROTOCOL_VERSION,
                capabilities: { elicitation: { form: {} } },
                clientInfo: { name: 'test-client', version: '1.0.0' }
            }
        });
        await initializeResponse;

        let sawElicitationRequest = false;
        clientTransport.onmessage = async message => {
            if ('method' in message && 'id' in message && message.method === 'elicitation/create') {
                sawElicitationRequest = true;
                await clientTransport.send({
                    jsonrpc: '2.0',
                    id: message.id,
                    result: { action: 'decline' }
                });
            }
        };

        await expect(
            server.elicitInput({
                message: 'Where should we ship it?',
                requestedSchema: z.object({
                    address: z.object({
                        city: z.string()
                    })
                })
            })
        ).rejects.toThrow(/flat primitive properties/);
        expect(sawElicitationRequest).toBe(false);

        await server.close();
        await clientTransport.close();
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
