/**
 * Regression test for https://github.com/modelcontextprotocol/typescript-sdk/issues/1362
 *
 * Zod v4's `.toJSONSchema()` produces standard JSON Schema output that includes
 * fields like `$schema` and `additionalProperties`. These fields were rejected
 * by the `requestedSchema` type in `ElicitRequestFormParams`, even though the
 * output is valid JSON Schema and works correctly at runtime.
 *
 * This test verifies that Zod's `.toJSONSchema()` output is accepted by
 * `elicitInput()` without type errors or runtime failures.
 */

import { Client } from '@modelcontextprotocol/client';
import type { ElicitRequestFormParams } from '@modelcontextprotocol/core';
import { AjvJsonSchemaValidator, InMemoryTransport } from '@modelcontextprotocol/core';
import { Server } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

describe('Issue #1362: Zod toJSONSchema() compatibility with elicitInput', () => {
    let server: Server;
    let client: Client;

    beforeEach(async () => {
        server = new Server(
            { name: 'test-server', version: '1.0.0' },
            {
                capabilities: {},
                jsonSchemaValidator: new AjvJsonSchemaValidator()
            }
        );

        client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: { elicitation: {} } });

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    });

    test('should accept Zod toJSONSchema() output as requestedSchema', async () => {
        const zodSchema = z.object({
            name: z.string().describe('Your full name'),
            color: z.enum(['red', 'green', 'blue']).describe('Favorite color')
        });

        const jsonSchema = zodSchema.toJSONSchema();

        // Verify the Zod output contains the fields that previously caused type errors
        expect(jsonSchema).toHaveProperty('$schema');
        expect(jsonSchema).toHaveProperty('additionalProperties');
        expect(jsonSchema).toHaveProperty('type', 'object');

        client.setRequestHandler('elicitation/create', _request => ({
            action: 'accept',
            content: { name: 'Alice', color: 'red' }
        }));

        // This should compile without type errors and work at runtime.
        // Before the fix, passing jsonSchema directly here would produce a
        // TypeScript error because `additionalProperties` was not in the type.
        const requestedSchema = jsonSchema as ElicitRequestFormParams['requestedSchema'];

        const result = await server.elicitInput({
            mode: 'form',
            message: 'Please provide your information',
            requestedSchema
        });

        expect(result).toEqual({
            action: 'accept',
            content: { name: 'Alice', color: 'red' }
        });
    });

    test('should accept schema with additionalProperties field', async () => {
        // Directly construct a schema with additionalProperties (as Zod produces)
        const params: ElicitRequestFormParams = {
            mode: 'form',
            message: 'Enter your details',
            requestedSchema: {
                $schema: 'https://json-schema.org/draft/2020-12/schema',
                type: 'object',
                properties: {
                    email: { type: 'string', format: 'email', description: 'Your email' }
                },
                required: ['email'],
                additionalProperties: false
            }
        };

        client.setRequestHandler('elicitation/create', _request => ({
            action: 'accept',
            content: { email: 'test@example.com' }
        }));

        const result = await server.elicitInput(params);

        expect(result).toEqual({
            action: 'accept',
            content: { email: 'test@example.com' }
        });
    });
});
