/**
 * Comprehensive elicitation flow tests with validator integration
 *
 * These tests verify the end-to-end elicitation flow from server requesting
 * input to client responding and validation of the response against schemas.
 *
 * Per the MCP spec, elicitation only supports object schemas, not primitives.
 */

import { Client } from '@modelcontextprotocol/client';
import type { ElicitRequestFormParams } from '@modelcontextprotocol/core';
import { AjvJsonSchemaValidator, CfWorkerJsonSchemaValidator, InMemoryTransport } from '@modelcontextprotocol/core';
import { Server } from '@modelcontextprotocol/server';

const ajvProvider = new AjvJsonSchemaValidator();
const cfWorkerProvider = new CfWorkerJsonSchemaValidator();

let server: Server;
let client: Client;

describe('Elicitation Flow', () => {
    describe('with AJV validator', () => {
        beforeEach(async () => {
            server = new Server(
                { name: 'test-server', version: '1.0.0' },
                {
                    capabilities: {},
                    jsonSchemaValidator: ajvProvider
                }
            );

            client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: { elicitation: {} } });

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
        });

        testElicitationFlow(ajvProvider, 'AJV');
    });

    describe('with CfWorker validator', () => {
        beforeEach(async () => {
            server = new Server(
                { name: 'test-server', version: '1.0.0' },
                {
                    capabilities: {},
                    jsonSchemaValidator: cfWorkerProvider
                }
            );

            client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: { elicitation: {} } });

            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

            await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
        });

        testElicitationFlow(cfWorkerProvider, 'CfWorker');
    });
});

function testElicitationFlow(validatorProvider: typeof ajvProvider | typeof cfWorkerProvider, validatorName: string) {
    test(`${validatorName}: should elicit simple object with string field`, async () => {
        client.setRequestHandler('elicitation/create', _request => ({
            action: 'accept',
            content: { name: 'John Doe' }
        }));

        const result = await server.elicitInput({
            mode: 'form',
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
        client.setRequestHandler('elicitation/create', _request => ({
            action: 'accept',
            content: { age: 42 }
        }));

        const result = await server.elicitInput({
            mode: 'form',
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
        client.setRequestHandler('elicitation/create', _request => ({
            action: 'accept',
            content: { agree: true }
        }));

        const result = await server.elicitInput({
            mode: 'form',
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

        client.setRequestHandler('elicitation/create', _request => ({
            action: 'accept',
            content: userData
        }));

        const formRequestParams: ElicitRequestFormParams = {
            mode: 'form',
            message: 'Please provide your information',
            requestedSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string', minLength: 1 },
                    email: { type: 'string', format: 'email' },
                    age: { type: 'integer', minimum: 0, maximum: 150 },
                    street: { type: 'string' },
                    city: { type: 'string' },
                    // @ts-expect-error - pattern is not a valid property by MCP spec, however it is making use of the Ajv validator
                    zipCode: { type: 'string', pattern: '^[0-9]{5}$' },
                    newsletter: { type: 'boolean' },
                    notifications: { type: 'boolean' }
                },
                required: ['name', 'email', 'age', 'street', 'city', 'zipCode']
            }
        };
        const result = await server.elicitInput(formRequestParams);

        expect(result).toEqual({
            action: 'accept',
            content: userData
        });
    });

    test(`${validatorName}: should reject invalid object (missing required field)`, async () => {
        client.setRequestHandler('elicitation/create', _request => ({
            action: 'accept',
            content: {
                email: 'user@example.com'
                // Missing required 'name' field
            }
        }));

        await expect(
            server.elicitInput({
                mode: 'form',
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
        client.setRequestHandler('elicitation/create', _request => ({
            action: 'accept',
            content: {
                name: 'John Doe',
                age: 'thirty' // Wrong type - should be integer
            }
        }));

        await expect(
            server.elicitInput({
                mode: 'form',
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
        client.setRequestHandler('elicitation/create', _request => ({
            action: 'accept',
            content: { name: '' } // Too short
        }));

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
        client.setRequestHandler('elicitation/create', _request => ({
            action: 'accept',
            content: { age: 200 } // Too high
        }));

        await expect(
            server.elicitInput({
                mode: 'form',
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
        client.setRequestHandler('elicitation/create', _request => ({
            action: 'accept',
            content: { zipCode: 'ABC123' } // Doesn't match pattern
        }));

        const formRequestParams: ElicitRequestFormParams = {
            mode: 'form',
            message: 'Enter a 5-digit zip code',
            requestedSchema: {
                type: 'object',
                properties: {
                    // @ts-expect-error - pattern is not a valid property by MCP spec, however it is making use of the Ajv validator
                    zipCode: { type: 'string', pattern: '^[0-9]{5}$' }
                },
                required: ['zipCode']
            }
        };

        await expect(server.elicitInput(formRequestParams)).rejects.toThrow(/does not match requested schema/);
    });

    test(`${validatorName}: should allow decline action without validation`, async () => {
        client.setRequestHandler('elicitation/create', _request => ({
            action: 'decline'
        }));

        const result = await server.elicitInput({
            mode: 'form',
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
        client.setRequestHandler('elicitation/create', _request => ({
            action: 'cancel'
        }));

        const result = await server.elicitInput({
            mode: 'form',
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
        let requestCount = 0;
        client.setRequestHandler('elicitation/create', request => {
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

        const nameResult = await server.elicitInput({
            mode: 'form',
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
        client.setRequestHandler('elicitation/create', _request => ({
            action: 'accept',
            content: { name: 'John', nickname: 'Johnny' }
        }));

        const result = await server.elicitInput({
            mode: 'form',
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
        client.setRequestHandler('elicitation/create', _request => ({
            action: 'accept',
            content: { name: 'John' }
        }));

        const result = await server.elicitInput({
            mode: 'form',
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
        client.setRequestHandler('elicitation/create', _request => ({
            action: 'accept',
            content: { email: 'user@example.com' }
        }));

        const result = await server.elicitInput({
            mode: 'form',
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

    test(`${validatorName}: should default missing fields from schema defaults`, async () => {
        const server = new Server(
            { name: 'test-server', version: '1.0.0' },
            {
                capabilities: {},
                jsonSchemaValidator: validatorProvider
            }
        );

        const client = new Client(
            { name: 'test-client', version: '1.0.0' },
            {
                capabilities: {
                    elicitation: {
                        form: {
                            applyDefaults: true
                        }
                    }
                }
            }
        );

        const testSchemaProperties: ElicitRequestFormParams['requestedSchema'] = {
            type: 'object',
            properties: {
                subscribe: { type: 'boolean', default: true },
                nickname: { type: 'string', default: 'Guest' },
                age: { type: 'integer', minimum: 0, maximum: 150, default: 18 },
                color: { type: 'string', enum: ['red', 'green'], default: 'green' },
                untitledSingleSelectEnum: {
                    type: 'string',
                    title: 'Untitled Single Select Enum',
                    description: 'Choose your favorite color',
                    enum: ['red', 'green', 'blue'],
                    default: 'green'
                },
                untitledMultipleSelectEnum: {
                    type: 'array',
                    title: 'Untitled Multiple Select Enum',
                    description: 'Choose your favorite colors',
                    minItems: 1,
                    maxItems: 3,
                    items: { type: 'string', enum: ['red', 'green', 'blue'] },
                    default: ['green', 'blue']
                },
                titledSingleSelectEnum: {
                    type: 'string',
                    title: 'Single Select Enum',
                    description: 'Choose your favorite color',
                    oneOf: [
                        { const: 'red', title: 'Red' },
                        { const: 'green', title: 'Green' },
                        { const: 'blue', title: 'Blue' }
                    ],
                    default: 'green'
                },
                titledMultipleSelectEnum: {
                    type: 'array',
                    title: 'Multiple Select Enum',
                    description: 'Choose your favorite colors',
                    minItems: 1,
                    maxItems: 3,
                    items: {
                        anyOf: [
                            { const: 'red', title: 'Red' },
                            { const: 'green', title: 'Green' },
                            { const: 'blue', title: 'Blue' }
                        ]
                    },
                    default: ['green', 'blue']
                },
                legacyTitledEnum: {
                    type: 'string',
                    title: 'Legacy Titled Enum',
                    description: 'Choose your favorite color',
                    enum: ['red', 'green', 'blue'],
                    enumNames: ['Red', 'Green', 'Blue'],
                    default: 'green'
                },
                optionalWithADefault: { type: 'string', default: 'default value' }
            },
            required: [
                'subscribe',
                'nickname',
                'age',
                'color',
                'titledSingleSelectEnum',
                'titledMultipleSelectEnum',
                'untitledSingleSelectEnum',
                'untitledMultipleSelectEnum'
            ]
        };

        // Client returns no values; SDK should apply defaults automatically (and validate)
        client.setRequestHandler('elicitation/create', request => {
            expect(request.params.mode).toEqual('form');
            expect((request.params as ElicitRequestFormParams).requestedSchema).toEqual(testSchemaProperties);
            return {
                action: 'accept',
                content: {}
            };
        });

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        const result = await server.elicitInput({
            mode: 'form',
            message: 'Provide your preferences',
            requestedSchema: testSchemaProperties
        });

        expect(result).toEqual({
            action: 'accept',
            content: {
                subscribe: true,
                nickname: 'Guest',
                age: 18,
                color: 'green',
                untitledSingleSelectEnum: 'green',
                untitledMultipleSelectEnum: ['green', 'blue'],
                titledSingleSelectEnum: 'green',
                titledMultipleSelectEnum: ['green', 'blue'],
                legacyTitledEnum: 'green',
                optionalWithADefault: 'default value'
            }
        });
    });

    test(`${validatorName}: should reject invalid email format`, async () => {
        client.setRequestHandler('elicitation/create', _request => ({
            action: 'accept',
            content: { email: 'not-an-email' }
        }));

        await expect(
            server.elicitInput({
                mode: 'form',
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

    // Enums - Valid - Single Select - Untitled / Titled

    test(`${validatorName}: should succeed with valid selection in single-select untitled enum`, async () => {
        // Set up client to return valid response
        client.setRequestHandler('elicitation/create', _request => ({
            action: 'accept',
            content: {
                color: 'Red'
            }
        }));

        // Test with valid response
        await expect(
            server.elicitInput({
                mode: 'form',
                message: 'Please provide your information',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        color: {
                            type: 'string',
                            title: 'Color Selection',
                            description: 'Choose your favorite color',
                            enum: ['Red', 'Green', 'Blue'],
                            default: 'Green'
                        }
                    },
                    required: ['color']
                }
            })
        ).resolves.toEqual({
            action: 'accept',
            content: {
                color: 'Red'
            }
        });
    });

    test(`${validatorName}: should succeed with valid selection in single-select titled enum`, async () => {
        // Set up client to return valid response
        client.setRequestHandler('elicitation/create', _request => ({
            action: 'accept',
            content: {
                color: '#FF0000'
            }
        }));

        // Test with valid response
        await expect(
            server.elicitInput({
                mode: 'form',
                message: 'Please provide your information',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        color: {
                            type: 'string',
                            title: 'Color Selection',
                            description: 'Choose your favorite color',
                            oneOf: [
                                { const: '#FF0000', title: 'Red' },
                                { const: '#00FF00', title: 'Green' },
                                { const: '#0000FF', title: 'Blue' }
                            ],
                            default: '#00FF00'
                        }
                    },
                    required: ['color']
                }
            })
        ).resolves.toEqual({
            action: 'accept',
            content: {
                color: '#FF0000'
            }
        });
    });

    test(`${validatorName}: should succeed with valid selection in single-select titled legacy enum`, async () => {
        // Set up client to return valid response
        client.setRequestHandler('elicitation/create', _request => ({
            action: 'accept',
            content: {
                color: '#FF0000'
            }
        }));

        // Test with valid response
        await expect(
            server.elicitInput({
                message: 'Please provide your information',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        color: {
                            type: 'string',
                            title: 'Color Selection',
                            description: 'Choose your favorite color',
                            enum: ['#FF0000', '#00FF00', '#0000FF'],
                            enumNames: ['Red', 'Green', 'Blue'],
                            default: '#00FF00'
                        }
                    },
                    required: ['color']
                }
            })
        ).resolves.toEqual({
            action: 'accept',
            content: {
                color: '#FF0000'
            }
        });
    });

    // Enums - Valid - Multi Select - Untitled / Titled

    test(`${validatorName}: should succeed with valid selection in multi-select untitled enum`, async () => {
        // Set up client to return valid response
        client.setRequestHandler('elicitation/create', _request => ({
            action: 'accept',
            content: {
                colors: ['Red', 'Blue']
            }
        }));

        // Test with valid response
        await expect(
            server.elicitInput({
                mode: 'form',
                message: 'Please provide your information',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        colors: {
                            type: 'array',
                            title: 'Color Selection',
                            description: 'Choose your favorite colors',
                            minItems: 1,
                            maxItems: 3,
                            items: {
                                type: 'string',
                                enum: ['Red', 'Green', 'Blue']
                            }
                        }
                    },
                    required: ['colors']
                }
            })
        ).resolves.toEqual({
            action: 'accept',
            content: {
                colors: ['Red', 'Blue']
            }
        });
    });

    test(`${validatorName}: should succeed with valid selection in multi-select titled enum`, async () => {
        // Set up client to return valid response
        client.setRequestHandler('elicitation/create', _request => ({
            action: 'accept',
            content: {
                colors: ['#FF0000', '#0000FF']
            }
        }));

        // Test with valid response
        await expect(
            server.elicitInput({
                mode: 'form',
                message: 'Please provide your information',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        colors: {
                            type: 'array',
                            title: 'Color Selection',
                            description: 'Choose your favorite colors',
                            minItems: 1,
                            maxItems: 3,
                            items: {
                                anyOf: [
                                    { const: '#FF0000', title: 'Red' },
                                    { const: '#00FF00', title: 'Green' },
                                    { const: '#0000FF', title: 'Blue' }
                                ]
                            }
                        }
                    },
                    required: ['colors']
                }
            })
        ).resolves.toEqual({
            action: 'accept',
            content: {
                colors: ['#FF0000', '#0000FF']
            }
        });
    });

    // Enums - Invalid - Single Select - Untitled / Titled

    test(`${validatorName}: should reject invalid selection in single-select untitled enum`, async () => {
        // Set up client to return valid response
        client.setRequestHandler('elicitation/create', _request => ({
            action: 'accept',
            content: {
                color: 'Black' // Color not in enum list
            }
        }));

        // Test with valid response
        await expect(
            server.elicitInput({
                mode: 'form',
                message: 'Please provide your information',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        color: {
                            type: 'string',
                            title: 'Color Selection',
                            description: 'Choose your favorite color',
                            enum: ['Red', 'Green', 'Blue'],
                            default: 'Green'
                        }
                    },
                    required: ['color']
                }
            })
        ).rejects.toThrow(/^MCP error -32602: Elicitation response content does not match requested schema/);
    });

    test(`${validatorName}: should reject invalid selection in single-select titled enum`, async () => {
        // Set up client to return valid response
        client.setRequestHandler('elicitation/create', _request => ({
            action: 'accept',
            content: {
                color: 'Red' // Should be "#FF0000" (const not title)
            }
        }));

        // Test with valid response
        await expect(
            server.elicitInput({
                message: 'Please provide your information',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        color: {
                            type: 'string',
                            title: 'Color Selection',
                            description: 'Choose your favorite color',
                            oneOf: [
                                { const: '#FF0000', title: 'Red' },
                                { const: '#00FF00', title: 'Green' },
                                { const: '#0000FF', title: 'Blue' }
                            ],
                            default: '#00FF00'
                        }
                    },
                    required: ['color']
                }
            })
        ).rejects.toThrow(/^MCP error -32602: Elicitation response content does not match requested schema/);
    });

    test(`${validatorName}: should reject invalid selection in single-select titled legacy enum`, async () => {
        // Set up client to return valid response
        client.setRequestHandler('elicitation/create', _request => ({
            action: 'accept',
            content: {
                color: 'Red' // Should be "#FF0000" (enum not enumNames)
            }
        }));

        // Test with valid response
        await expect(
            server.elicitInput({
                message: 'Please provide your information',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        color: {
                            type: 'string',
                            title: 'Color Selection',
                            description: 'Choose your favorite color',
                            enum: ['#FF0000', '#00FF00', '#0000FF'],
                            enumNames: ['Red', 'Green', 'Blue'],
                            default: '#00FF00'
                        }
                    },
                    required: ['color']
                }
            })
        ).rejects.toThrow(/^MCP error -32602: Elicitation response content does not match requested schema/);
    });

    // Enums - Invalid - Multi Select - Untitled / Titled

    test(`${validatorName}: should reject invalid selection in multi-select untitled enum`, async () => {
        // Set up client to return valid response
        client.setRequestHandler('elicitation/create', _request => ({
            action: 'accept',
            content: {
                color: 'Red' // Should be array, not string
            }
        }));

        // Test with valid response
        await expect(
            server.elicitInput({
                mode: 'form',
                message: 'Please provide your information',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        color: {
                            type: 'array',
                            title: 'Color Selection',
                            description: 'Choose your favorite colors',
                            minItems: 1,
                            maxItems: 3,
                            items: {
                                type: 'string',
                                enum: ['Red', 'Green', 'Blue']
                            }
                        }
                    },
                    required: ['color']
                }
            })
        ).rejects.toThrow(/^MCP error -32602: Elicitation response content does not match requested schema/);
    });

    test(`${validatorName}: should reject invalid selection in multi-select titled enum`, async () => {
        // Set up client to return valid response
        client.setRequestHandler('elicitation/create', _request => ({
            action: 'accept',
            content: {
                colors: ['Red', 'Blue'] // Should be  ["#FF0000", "#0000FF"] (const not title)
            }
        }));

        // Test with valid response
        await expect(
            server.elicitInput({
                mode: 'form',
                message: 'Please provide your information',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        colors: {
                            type: 'array',
                            title: 'Color Selection',
                            description: 'Choose your favorite colors',
                            minItems: 1,
                            maxItems: 3,
                            items: {
                                anyOf: [
                                    { const: '#FF0000', title: 'Red' },
                                    { const: '#00FF00', title: 'Green' },
                                    { const: '#0000FF', title: 'Blue' }
                                ]
                            }
                        }
                    },
                    required: ['colors']
                }
            })
        ).rejects.toThrow(/^MCP error -32602: Elicitation response content does not match requested schema/);
    });
}
