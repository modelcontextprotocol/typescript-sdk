/**
 * Comprehensive elicitation flow tests with validator integration
 *
 * These tests verify the end-to-end elicitation flow from server requesting
 * input to client responding and validation of the response against schemas.
 *
 * Per the MCP spec, elicitation only supports object schemas, not primitives.
 */

import { Client } from '../client/index.js';
import { InMemoryTransport } from '../inMemory.js';
import { ElicitRequestSchema } from '../types.js';
import { AjvJsonSchemaValidator } from '../validation/ajv-provider.js';
import { CfWorkerJsonSchemaValidator } from '../validation/cfworker-provider.js';
import { Server } from './index.js';

const ajvProvider = new AjvJsonSchemaValidator();
const cfWorkerProvider = new CfWorkerJsonSchemaValidator();

describe('Elicitation Flow', () => {
    describe('with AJV validator', () => {
        testElicitationFlow(ajvProvider, 'AJV');
    });

    describe('with CfWorker validator', () => {
        testElicitationFlow(cfWorkerProvider, 'CfWorker');
    });
});

function testElicitationFlow(validatorProvider: typeof ajvProvider | typeof cfWorkerProvider, validatorName: string) {
    test(`${validatorName}: should elicit simple object with string field`, async () => {
        const server = new Server(
            { name: 'test-server', version: '1.0.0' },
            {
                capabilities: {},
                jsonSchemaValidator: validatorProvider
            }
        );

        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: { elicitation: {} } });

        client.setRequestHandler(ElicitRequestSchema, _request => ({
            action: 'accept',
            content: { name: 'John Doe' }
        }));

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        const result = await server.elicitInput({
            message: 'What is your name?',
            requestedSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string', minLength: 1 }
                },
                required: ['name']
            }
        });

        expect(result).toEqual({
            action: 'accept',
            content: { name: 'John Doe' }
        });
    });

    test(`${validatorName}: should elicit object with integer field`, async () => {
        const server = new Server(
            { name: 'test-server', version: '1.0.0' },
            {
                capabilities: {},
                jsonSchemaValidator: validatorProvider
            }
        );

        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: { elicitation: {} } });

        client.setRequestHandler(ElicitRequestSchema, _request => ({
            action: 'accept',
            content: { age: 42 }
        }));

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        const result = await server.elicitInput({
            message: 'What is your age?',
            requestedSchema: {
                type: 'object',
                properties: {
                    age: { type: 'integer', minimum: 0, maximum: 150 }
                },
                required: ['age']
            }
        });

        expect(result).toEqual({
            action: 'accept',
            content: { age: 42 }
        });
    });

    test(`${validatorName}: should elicit object with boolean field`, async () => {
        const server = new Server(
            { name: 'test-server', version: '1.0.0' },
            {
                capabilities: {},
                jsonSchemaValidator: validatorProvider
            }
        );

        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: { elicitation: {} } });

        client.setRequestHandler(ElicitRequestSchema, _request => ({
            action: 'accept',
            content: { agree: true }
        }));

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        const result = await server.elicitInput({
            message: 'Do you agree?',
            requestedSchema: {
                type: 'object',
                properties: {
                    agree: { type: 'boolean' }
                },
                required: ['agree']
            }
        });

        expect(result).toEqual({
            action: 'accept',
            content: { agree: true }
        });
    });

    test(`${validatorName}: should elicit complex object with multiple fields`, async () => {
        const server = new Server(
            { name: 'test-server', version: '1.0.0' },
            {
                capabilities: {},
                jsonSchemaValidator: validatorProvider
            }
        );

        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: { elicitation: {} } });

        const userData = {
            name: 'Jane Smith',
            email: 'jane@example.com',
            age: 28,
            street: '123 Main St',
            city: 'San Francisco',
            zipCode: '94105',
            newsletter: true,
            notifications: false
        };

        client.setRequestHandler(ElicitRequestSchema, _request => ({
            action: 'accept',
            content: userData
        }));

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        const result = await server.elicitInput({
            message: 'Please provide your information',
            requestedSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string', minLength: 1 },
                    email: { type: 'string', format: 'email' },
                    age: { type: 'integer', minimum: 0, maximum: 150 },
                    street: { type: 'string' },
                    city: { type: 'string' },
                    zipCode: { type: 'string', pattern: '^[0-9]{5}$' },
                    newsletter: { type: 'boolean' },
                    notifications: { type: 'boolean' }
                },
                required: ['name', 'email', 'age', 'street', 'city', 'zipCode']
            }
        });

        expect(result).toEqual({
            action: 'accept',
            content: userData
        });
    });

    test(`${validatorName}: should reject invalid object (missing required field)`, async () => {
        const server = new Server(
            { name: 'test-server', version: '1.0.0' },
            {
                capabilities: {},
                jsonSchemaValidator: validatorProvider
            }
        );

        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: { elicitation: {} } });

        client.setRequestHandler(ElicitRequestSchema, _request => ({
            action: 'accept',
            content: {
                email: 'user@example.com'
                // Missing required 'name' field
            }
        }));

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        await expect(
            server.elicitInput({
                message: 'Please provide your information',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        email: { type: 'string' }
                    },
                    required: ['name', 'email']
                }
            })
        ).rejects.toThrow(/does not match requested schema/);
    });

    test(`${validatorName}: should reject invalid field type`, async () => {
        const server = new Server(
            { name: 'test-server', version: '1.0.0' },
            {
                capabilities: {},
                jsonSchemaValidator: validatorProvider
            }
        );

        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: { elicitation: {} } });

        client.setRequestHandler(ElicitRequestSchema, _request => ({
            action: 'accept',
            content: {
                name: 'John Doe',
                age: 'thirty' // Wrong type - should be integer
            }
        }));

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        await expect(
            server.elicitInput({
                message: 'Please provide your information',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        age: { type: 'integer' }
                    },
                    required: ['name', 'age']
                }
            })
        ).rejects.toThrow(/does not match requested schema/);
    });

    test(`${validatorName}: should reject invalid string (too short)`, async () => {
        const server = new Server(
            { name: 'test-server', version: '1.0.0' },
            {
                capabilities: {},
                jsonSchemaValidator: validatorProvider
            }
        );

        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: { elicitation: {} } });

        client.setRequestHandler(ElicitRequestSchema, _request => ({
            action: 'accept',
            content: { name: '' } // Too short
        }));

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        await expect(
            server.elicitInput({
                message: 'What is your name?',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', minLength: 1 }
                    },
                    required: ['name']
                }
            })
        ).rejects.toThrow(/does not match requested schema/);
    });

    test(`${validatorName}: should reject invalid integer (out of range)`, async () => {
        const server = new Server(
            { name: 'test-server', version: '1.0.0' },
            {
                capabilities: {},
                jsonSchemaValidator: validatorProvider
            }
        );

        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: { elicitation: {} } });

        client.setRequestHandler(ElicitRequestSchema, _request => ({
            action: 'accept',
            content: { age: 200 } // Too high
        }));

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        await expect(
            server.elicitInput({
                message: 'What is your age?',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        age: { type: 'integer', minimum: 0, maximum: 150 }
                    },
                    required: ['age']
                }
            })
        ).rejects.toThrow(/does not match requested schema/);
    });

    test(`${validatorName}: should reject invalid pattern`, async () => {
        const server = new Server(
            { name: 'test-server', version: '1.0.0' },
            {
                capabilities: {},
                jsonSchemaValidator: validatorProvider
            }
        );

        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: { elicitation: {} } });

        client.setRequestHandler(ElicitRequestSchema, _request => ({
            action: 'accept',
            content: { zipCode: 'ABC123' } // Doesn't match pattern
        }));

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        await expect(
            server.elicitInput({
                message: 'Enter a 5-digit zip code',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        zipCode: { type: 'string', pattern: '^[0-9]{5}$' }
                    },
                    required: ['zipCode']
                }
            })
        ).rejects.toThrow(/does not match requested schema/);
    });

    test(`${validatorName}: should allow decline action without validation`, async () => {
        const server = new Server(
            { name: 'test-server', version: '1.0.0' },
            {
                capabilities: {},
                jsonSchemaValidator: validatorProvider
            }
        );

        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: { elicitation: {} } });

        client.setRequestHandler(ElicitRequestSchema, _request => ({
            action: 'decline'
        }));

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        const result = await server.elicitInput({
            message: 'Please provide your information',
            requestedSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string' }
                },
                required: ['name']
            }
        });

        expect(result).toEqual({
            action: 'decline'
        });
    });

    test(`${validatorName}: should allow cancel action without validation`, async () => {
        const server = new Server(
            { name: 'test-server', version: '1.0.0' },
            {
                capabilities: {},
                jsonSchemaValidator: validatorProvider
            }
        );

        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: { elicitation: {} } });

        client.setRequestHandler(ElicitRequestSchema, _request => ({
            action: 'cancel'
        }));

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        const result = await server.elicitInput({
            message: 'Please provide your information',
            requestedSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string' }
                },
                required: ['name']
            }
        });

        expect(result).toEqual({
            action: 'cancel'
        });
    });

    test(`${validatorName}: should handle multiple sequential elicitation requests`, async () => {
        const server = new Server(
            { name: 'test-server', version: '1.0.0' },
            {
                capabilities: {},
                jsonSchemaValidator: validatorProvider
            }
        );

        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: { elicitation: {} } });

        let requestCount = 0;
        client.setRequestHandler(ElicitRequestSchema, request => {
            requestCount++;
            if (request.params.message.includes('name')) {
                return { action: 'accept', content: { name: 'Alice' } };
            } else if (request.params.message.includes('age')) {
                return { action: 'accept', content: { age: 30 } };
            } else if (request.params.message.includes('city')) {
                return { action: 'accept', content: { city: 'New York' } };
            }
            return { action: 'decline' };
        });

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        const nameResult = await server.elicitInput({
            message: 'What is your name?',
            requestedSchema: {
                type: 'object',
                properties: { name: { type: 'string', minLength: 1 } },
                required: ['name']
            }
        });

        const ageResult = await server.elicitInput({
            message: 'What is your age?',
            requestedSchema: {
                type: 'object',
                properties: { age: { type: 'integer', minimum: 0 } },
                required: ['age']
            }
        });

        const cityResult = await server.elicitInput({
            message: 'What is your city?',
            requestedSchema: {
                type: 'object',
                properties: { city: { type: 'string', minLength: 1 } },
                required: ['city']
            }
        });

        expect(requestCount).toBe(3);
        expect(nameResult).toEqual({
            action: 'accept',
            content: { name: 'Alice' }
        });
        expect(ageResult).toEqual({ action: 'accept', content: { age: 30 } });
        expect(cityResult).toEqual({
            action: 'accept',
            content: { city: 'New York' }
        });
    });

    test(`${validatorName}: should validate with optional fields present`, async () => {
        const server = new Server(
            { name: 'test-server', version: '1.0.0' },
            {
                capabilities: {},
                jsonSchemaValidator: validatorProvider
            }
        );

        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: { elicitation: {} } });

        client.setRequestHandler(ElicitRequestSchema, _request => ({
            action: 'accept',
            content: { name: 'John', nickname: 'Johnny' }
        }));

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        const result = await server.elicitInput({
            message: 'Enter your name',
            requestedSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string', minLength: 1 },
                    nickname: { type: 'string' }
                },
                required: ['name']
            }
        });

        expect(result).toEqual({
            action: 'accept',
            content: { name: 'John', nickname: 'Johnny' }
        });
    });

    test(`${validatorName}: should validate with optional fields absent`, async () => {
        const server = new Server(
            { name: 'test-server', version: '1.0.0' },
            {
                capabilities: {},
                jsonSchemaValidator: validatorProvider
            }
        );

        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: { elicitation: {} } });

        client.setRequestHandler(ElicitRequestSchema, _request => ({
            action: 'accept',
            content: { name: 'John' }
        }));

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        const result = await server.elicitInput({
            message: 'Enter your name',
            requestedSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string', minLength: 1 },
                    nickname: { type: 'string' }
                },
                required: ['name']
            }
        });

        expect(result).toEqual({
            action: 'accept',
            content: { name: 'John' }
        });
    });

    test(`${validatorName}: should validate email format`, async () => {
        const server = new Server(
            { name: 'test-server', version: '1.0.0' },
            {
                capabilities: {},
                jsonSchemaValidator: validatorProvider
            }
        );

        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: { elicitation: {} } });

        client.setRequestHandler(ElicitRequestSchema, _request => ({
            action: 'accept',
            content: { email: 'user@example.com' }
        }));

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        const result = await server.elicitInput({
            message: 'Enter your email',
            requestedSchema: {
                type: 'object',
                properties: {
                    email: { type: 'string', format: 'email' }
                },
                required: ['email']
            }
        });

        expect(result).toEqual({
            action: 'accept',
            content: { email: 'user@example.com' }
        });
    });

    test(`${validatorName}: should reject invalid email format`, async () => {
        const server = new Server(
            { name: 'test-server', version: '1.0.0' },
            {
                capabilities: {},
                jsonSchemaValidator: validatorProvider
            }
        );

        const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: { elicitation: {} } });

        client.setRequestHandler(ElicitRequestSchema, _request => ({
            action: 'accept',
            content: { email: 'not-an-email' }
        }));

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        await expect(
            server.elicitInput({
                message: 'Enter your email',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        email: { type: 'string', format: 'email' }
                    },
                    required: ['email']
                }
            })
        ).rejects.toThrow(/does not match requested schema/);
    });
}
