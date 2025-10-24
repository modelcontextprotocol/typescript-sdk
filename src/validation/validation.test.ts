/**
 * Tests all validator providers with various JSON Schema 2020-12 features
 * Based on MCP specification for elicitation schemas:
 * https://modelcontextprotocol.io/specification/draft/client/elicitation.md
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AjvJsonSchemaValidator } from './ajv-provider.js';
import { CfWorkerJsonSchemaValidator } from './cfworker-provider.js';
import type { JsonSchemaType } from './types.js';

// Test with both AJV and CfWorker validators
// AJV validator will use default configuration with format validation enabled
const validators = [
    { name: 'AJV', provider: new AjvJsonSchemaValidator() },
    { name: 'CfWorker', provider: new CfWorkerJsonSchemaValidator() }
];

describe('JSON Schema Validators', () => {
    describe.each(validators)('$name Validator', ({ provider }) => {
        describe('String schemas', () => {
            it('validates basic string', () => {
                const schema: JsonSchemaType = {
                    type: 'string'
                };
                const validator = provider.getValidator(schema);

                const validResult = validator('hello');
                expect(validResult.valid).toBe(true);
                expect(validResult.data).toBe('hello');

                const invalidResult = validator(123);
                expect(invalidResult.valid).toBe(false);
                expect(invalidResult.errorMessage).toBeDefined();
            });

            it('validates string with title and description', () => {
                const schema: JsonSchemaType = {
                    type: 'string',
                    title: 'Name',
                    description: "User's full name"
                };
                const validator = provider.getValidator(schema);

                const result = validator('John Doe');
                expect(result.valid).toBe(true);
                expect(result.data).toBe('John Doe');
            });

            it('validates string with length constraints', () => {
                const schema: JsonSchemaType = {
                    type: 'string',
                    minLength: 3,
                    maxLength: 10
                };
                const validator = provider.getValidator(schema);

                expect(validator('abc').valid).toBe(true);
                expect(validator('abcdefghij').valid).toBe(true);
                expect(validator('ab').valid).toBe(false);
                expect(validator('abcdefghijk').valid).toBe(false);
            });

            it('validates email format', () => {
                const schema: JsonSchemaType = {
                    type: 'string',
                    format: 'email'
                };
                const validator = provider.getValidator(schema);

                expect(validator('user@example.com').valid).toBe(true);
                expect(validator('invalid-email').valid).toBe(false);
            });

            it('validates URI format', () => {
                const schema: JsonSchemaType = {
                    type: 'string',
                    format: 'uri'
                };
                const validator = provider.getValidator(schema);

                expect(validator('https://example.com').valid).toBe(true);
                expect(validator('not-a-uri').valid).toBe(false);
            });

            it('validates date-time format', () => {
                const schema: JsonSchemaType = {
                    type: 'string',
                    format: 'date-time'
                };
                const validator = provider.getValidator(schema);

                expect(validator('2025-10-17T12:00:00Z').valid).toBe(true);
                expect(validator('not-a-date').valid).toBe(false);
            });

            it('validates string pattern', () => {
                const schema: JsonSchemaType = {
                    type: 'string',
                    pattern: '^[A-Z]{3}$'
                };
                const validator = provider.getValidator(schema);

                expect(validator('ABC').valid).toBe(true);
                expect(validator('abc').valid).toBe(false);
                expect(validator('ABCD').valid).toBe(false);
            });
        });

        describe('Number schemas', () => {
            it('validates number type', () => {
                const schema: JsonSchemaType = {
                    type: 'number'
                };
                const validator = provider.getValidator(schema);

                expect(validator(42).valid).toBe(true);
                expect(validator(3.14).valid).toBe(true);
                expect(validator('42').valid).toBe(false);
            });

            it('validates integer type', () => {
                const schema: JsonSchemaType = {
                    type: 'integer'
                };
                const validator = provider.getValidator(schema);

                expect(validator(42).valid).toBe(true);
                expect(validator(3.14).valid).toBe(false);
            });

            it('validates number range', () => {
                const schema: JsonSchemaType = {
                    type: 'number',
                    minimum: 0,
                    maximum: 100
                };
                const validator = provider.getValidator(schema);

                expect(validator(0).valid).toBe(true);
                expect(validator(50).valid).toBe(true);
                expect(validator(100).valid).toBe(true);
                expect(validator(-1).valid).toBe(false);
                expect(validator(101).valid).toBe(false);
            });
        });

        describe('Boolean schemas', () => {
            it('validates boolean type', () => {
                const schema: JsonSchemaType = {
                    type: 'boolean'
                };
                const validator = provider.getValidator(schema);

                expect(validator(true).valid).toBe(true);
                expect(validator(false).valid).toBe(true);
                expect(validator('true').valid).toBe(false);
                expect(validator(1).valid).toBe(false);
            });

            it('validates boolean with default', () => {
                const schema: JsonSchemaType = {
                    type: 'boolean',
                    default: false
                };
                const validator = provider.getValidator(schema);

                expect(validator(true).valid).toBe(true);
                expect(validator(false).valid).toBe(true);
            });
        });

        describe('Enum schemas', () => {
            it('validates enum values', () => {
                const schema: JsonSchemaType = {
                    enum: ['red', 'green', 'blue']
                };
                const validator = provider.getValidator(schema);

                expect(validator('red').valid).toBe(true);
                expect(validator('green').valid).toBe(true);
                expect(validator('blue').valid).toBe(true);
                expect(validator('yellow').valid).toBe(false);
            });

            it('validates enum with mixed types', () => {
                const schema: JsonSchemaType = {
                    enum: ['option1', 42, true, null]
                };
                const validator = provider.getValidator(schema);

                expect(validator('option1').valid).toBe(true);
                expect(validator(42).valid).toBe(true);
                expect(validator(true).valid).toBe(true);
                expect(validator(null).valid).toBe(true);
                expect(validator('other').valid).toBe(false);
            });
        });

        describe('Object schemas', () => {
            it('validates simple object', () => {
                const schema: JsonSchemaType = {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        age: { type: 'number' }
                    },
                    required: ['name']
                };
                const validator = provider.getValidator(schema);

                expect(validator({ name: 'John', age: 30 }).valid).toBe(true);
                expect(validator({ name: 'John' }).valid).toBe(true);
                expect(validator({ age: 30 }).valid).toBe(false);
                expect(validator({}).valid).toBe(false);
            });

            it('validates nested objects', () => {
                const schema: JsonSchemaType = {
                    type: 'object',
                    properties: {
                        user: {
                            type: 'object',
                            properties: {
                                name: { type: 'string' },
                                email: { type: 'string', format: 'email' }
                            },
                            required: ['name']
                        }
                    },
                    required: ['user']
                };
                const validator = provider.getValidator(schema);

                expect(
                    validator({
                        user: { name: 'John', email: 'john@example.com' }
                    }).valid
                ).toBe(true);

                expect(
                    validator({
                        user: { name: 'John' }
                    }).valid
                ).toBe(true);

                expect(
                    validator({
                        user: { email: 'john@example.com' }
                    }).valid
                ).toBe(false);
            });

            it('validates object with additionalProperties: false', () => {
                const schema: JsonSchemaType = {
                    type: 'object',
                    properties: {
                        name: { type: 'string' }
                    },
                    additionalProperties: false
                };
                const validator = provider.getValidator(schema);

                expect(validator({ name: 'John' }).valid).toBe(true);
                expect(validator({ name: 'John', extra: 'field' }).valid).toBe(false);
            });
        });

        describe('Array schemas', () => {
            it('validates array of strings', () => {
                const schema: JsonSchemaType = {
                    type: 'array',
                    items: { type: 'string' }
                };
                const validator = provider.getValidator(schema);

                expect(validator(['a', 'b', 'c']).valid).toBe(true);
                expect(validator([]).valid).toBe(true);
                expect(validator(['a', 1, 'c']).valid).toBe(false);
            });

            it('validates array length constraints', () => {
                const schema: JsonSchemaType = {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 1,
                    maxItems: 3
                };
                const validator = provider.getValidator(schema);

                expect(validator([1]).valid).toBe(true);
                expect(validator([1, 2, 3]).valid).toBe(true);
                expect(validator([]).valid).toBe(false);
                expect(validator([1, 2, 3, 4]).valid).toBe(false);
            });

            it('validates array with unique items', () => {
                const schema: JsonSchemaType = {
                    type: 'array',
                    items: { type: 'number' },
                    uniqueItems: true
                };
                const validator = provider.getValidator(schema);

                expect(validator([1, 2, 3]).valid).toBe(true);
                expect(validator([1, 2, 2, 3]).valid).toBe(false);
            });
        });

        describe('JSON Schema 2020-12 features', () => {
            it('validates schema with $schema field', () => {
                const schema: JsonSchemaType = {
                    $schema: 'https://json-schema.org/draft/2020-12/schema',
                    type: 'string'
                };
                const validator = provider.getValidator(schema);

                expect(validator('test').valid).toBe(true);
            });

            it('validates schema with $id field', () => {
                const schema: JsonSchemaType = {
                    $id: 'https://example.com/schemas/test',
                    type: 'number'
                };
                const validator = provider.getValidator(schema);

                expect(validator(42).valid).toBe(true);
            });

            it('validates with allOf', () => {
                const schema: JsonSchemaType = {
                    allOf: [
                        { type: 'object', properties: { name: { type: 'string' } } },
                        { type: 'object', properties: { age: { type: 'number' } } }
                    ]
                };
                const validator = provider.getValidator(schema);

                expect(validator({ name: 'John', age: 30 }).valid).toBe(true);
                expect(validator({ name: 'John' }).valid).toBe(true);
                expect(validator({ name: 123 }).valid).toBe(false);
            });

            it('validates with anyOf', () => {
                const schema: JsonSchemaType = {
                    anyOf: [{ type: 'string' }, { type: 'number' }]
                };
                const validator = provider.getValidator(schema);

                expect(validator('test').valid).toBe(true);
                expect(validator(42).valid).toBe(true);
                expect(validator(true).valid).toBe(false);
            });

            it('validates with oneOf', () => {
                const schema: JsonSchemaType = {
                    oneOf: [
                        { type: 'string', minLength: 5 },
                        { type: 'string', maxLength: 3 }
                    ]
                };
                const validator = provider.getValidator(schema);

                expect(validator('ab').valid).toBe(true); // Matches second only
                expect(validator('hello').valid).toBe(true); // Matches first only
                expect(validator('abcd').valid).toBe(false); // Matches neither
            });

            it('validates with not', () => {
                const schema: JsonSchemaType = {
                    not: { type: 'null' }
                };
                const validator = provider.getValidator(schema);

                expect(validator('test').valid).toBe(true);
                expect(validator(42).valid).toBe(true);
                expect(validator(null).valid).toBe(false);
            });

            it('validates with const', () => {
                const schema: JsonSchemaType = {
                    const: 'specific-value'
                };
                const validator = provider.getValidator(schema);

                expect(validator('specific-value').valid).toBe(true);
                expect(validator('other-value').valid).toBe(false);
            });
        });

        describe('Complex real-world schemas', () => {
            it('validates user registration form', () => {
                const schema: JsonSchemaType = {
                    type: 'object',
                    properties: {
                        username: {
                            type: 'string',
                            minLength: 3,
                            maxLength: 20,
                            pattern: '^[a-zA-Z0-9_]+$'
                        },
                        email: {
                            type: 'string',
                            format: 'email'
                        },
                        age: {
                            type: 'integer',
                            minimum: 18,
                            maximum: 120
                        },
                        newsletter: {
                            type: 'boolean',
                            default: false
                        }
                    },
                    required: ['username', 'email']
                };
                const validator = provider.getValidator(schema);

                expect(
                    validator({
                        username: 'john_doe',
                        email: 'john@example.com',
                        age: 25,
                        newsletter: true
                    }).valid
                ).toBe(true);

                expect(
                    validator({
                        username: 'john_doe',
                        email: 'john@example.com'
                    }).valid
                ).toBe(true);

                expect(
                    validator({
                        username: 'ab', // Too short
                        email: 'john@example.com'
                    }).valid
                ).toBe(false);

                expect(
                    validator({
                        username: 'john_doe',
                        email: 'invalid-email'
                    }).valid
                ).toBe(false);
            });

            it('validates API response with nested structure', () => {
                const schema: JsonSchemaType = {
                    type: 'object',
                    properties: {
                        status: {
                            type: 'string',
                            enum: ['success', 'error', 'pending']
                        },
                        data: {
                            type: 'object',
                            properties: {
                                id: { type: 'string' },
                                items: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            name: { type: 'string' },
                                            quantity: { type: 'integer', minimum: 1 }
                                        },
                                        required: ['name', 'quantity']
                                    }
                                }
                            },
                            required: ['id', 'items']
                        },
                        timestamp: {
                            type: 'string',
                            format: 'date-time'
                        }
                    },
                    required: ['status', 'data']
                };
                const validator = provider.getValidator(schema);

                expect(
                    validator({
                        status: 'success',
                        data: {
                            id: '123',
                            items: [
                                { name: 'Item 1', quantity: 5 },
                                { name: 'Item 2', quantity: 3 }
                            ]
                        },
                        timestamp: '2025-10-17T12:00:00Z'
                    }).valid
                ).toBe(true);

                expect(
                    validator({
                        status: 'invalid-status',
                        data: { id: '123', items: [] }
                    }).valid
                ).toBe(false);
            });
        });

        describe('Error messages', () => {
            it('provides helpful error message on validation failure', () => {
                const schema: JsonSchemaType = {
                    type: 'object',
                    properties: {
                        name: { type: 'string' }
                    },
                    required: ['name']
                };
                const validator = provider.getValidator(schema);

                const result = validator({});
                expect(result.valid).toBe(false);
                expect(result.errorMessage).toBeDefined();
                expect(result.errorMessage).toBeTruthy();
                expect(typeof result.errorMessage).toBe('string');
            });
        });
    });
});

describe('Missing dependencies', () => {
    describe('AJV not installed but CfWorker is', () => {
        beforeEach(() => {
            jest.resetModules();
        });

        afterEach(() => {
            jest.unmock('ajv');
            jest.unmock('ajv-formats');
        });

        it('should throw error when trying to import ajv-provider without ajv', async () => {
            // Mock ajv as not installed
            jest.doMock('ajv', () => {
                throw new Error("Cannot find module 'ajv'");
            });

            jest.doMock('ajv-formats', () => {
                throw new Error("Cannot find module 'ajv-formats'");
            });

            // Attempting to import ajv-provider should fail
            await expect(import('./ajv-provider.js')).rejects.toThrow();
        });

        it('should be able to import cfworker-provider when ajv is missing', async () => {
            // Mock ajv as not installed
            jest.doMock('ajv', () => {
                throw new Error("Cannot find module 'ajv'");
            });

            jest.doMock('ajv-formats', () => {
                throw new Error("Cannot find module 'ajv-formats'");
            });

            // But cfworker-provider should import successfully
            const cfworkerModule = await import('./cfworker-provider.js');
            expect(cfworkerModule.CfWorkerJsonSchemaValidator).toBeDefined();

            // And should work correctly
            const validator = new cfworkerModule.CfWorkerJsonSchemaValidator();
            const schema: JsonSchemaType = { type: 'string' };
            const validatorFn = validator.getValidator(schema);
            expect(validatorFn('test').valid).toBe(true);
        });
    });

    describe('CfWorker not installed but AJV is', () => {
        beforeEach(() => {
            jest.resetModules();
        });

        afterEach(() => {
            jest.unmock('@cfworker/json-schema');
        });

        it('should throw error when trying to import cfworker-provider without @cfworker/json-schema', async () => {
            // Mock @cfworker/json-schema as not installed
            jest.doMock('@cfworker/json-schema', () => {
                throw new Error("Cannot find module '@cfworker/json-schema'");
            });

            // Attempting to import cfworker-provider should fail
            await expect(import('./cfworker-provider.js')).rejects.toThrow();
        });

        it('should be able to import ajv-provider when @cfworker/json-schema is missing', async () => {
            // Mock @cfworker/json-schema as not installed
            jest.doMock('@cfworker/json-schema', () => {
                throw new Error("Cannot find module '@cfworker/json-schema'");
            });

            // But ajv-provider should import successfully
            const ajvModule = await import('./ajv-provider.js');
            expect(ajvModule.AjvJsonSchemaValidator).toBeDefined();

            // And should work correctly
            const validator = new ajvModule.AjvJsonSchemaValidator();
            const schema: JsonSchemaType = { type: 'string' };
            const validatorFn = validator.getValidator(schema);
            expect(validatorFn('test').valid).toBe(true);
        });

        it('should document that @cfworker/json-schema is required', () => {
            const cfworkerProviderPath = join(__dirname, 'cfworker-provider.ts');
            const content = readFileSync(cfworkerProviderPath, 'utf-8');

            expect(content).toContain('@cfworker/json-schema');
        });
    });
});
