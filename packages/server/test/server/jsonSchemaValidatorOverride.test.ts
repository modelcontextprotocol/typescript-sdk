import type { JsonSchemaType, JsonSchemaValidatorResult, jsonSchemaValidator } from '@modelcontextprotocol/core';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/core';
import { fromJsonSchema } from '../../src/fromJsonSchema.js';
import { Server } from '../../src/server/server.js';

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
