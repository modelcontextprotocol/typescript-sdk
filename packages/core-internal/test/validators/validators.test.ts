/**
 * Tests all validator providers with various JSON Schema 2020-12 features
 * Based on MCP specification for elicitation schemas:
 * https://modelcontextprotocol.io/specification/draft/client/elicitation.md
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { vi } from 'vitest';

import { Ajv, AjvJsonSchemaValidator } from '../../src/validators/ajvProvider';
import { CfWorkerJsonSchemaValidator } from '../../src/validators/cfWorkerProvider';
import { declaredDialect } from '../../src/validators/dialects';
import type { JsonSchemaType } from '../../src/validators/types';

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
            vi.resetModules();
        });

        afterEach(() => {
            vi.doUnmock('ajv');
            vi.doUnmock('ajv-formats');
        });

        it('should throw error when trying to import ajv-provider without ajv', async () => {
            // Mock ajv as not installed
            vi.doMock('ajv', () => {
                throw new Error("Cannot find module 'ajv'");
            });

            vi.doMock('ajv-formats', () => {
                throw new Error("Cannot find module 'ajv-formats'");
            });

            // Attempting to import ajv-provider should fail
            await expect(import('../../src/validators/ajvProvider')).rejects.toThrow();
        });

        it('should be able to import cfWorkerProvider when ajv is missing', async () => {
            // Mock ajv as not installed
            vi.doMock('ajv', () => {
                throw new Error("Cannot find module 'ajv'");
            });

            vi.doMock('ajv-formats', () => {
                throw new Error("Cannot find module 'ajv-formats'");
            });

            // But cfWorkerProvider should import successfully
            const cfworkerModule = await import('../../src/validators/cfWorkerProvider');
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
            vi.resetModules();
        });

        afterEach(() => {
            vi.doUnmock('@cfworker/json-schema');
        });

        it('should throw error when trying to import cfWorkerProvider without @cfworker/json-schema', async () => {
            // Mock @cfworker/json-schema as not installed
            vi.doMock('@cfworker/json-schema', () => {
                throw new Error("Cannot find module '@cfworker/json-schema'");
            });

            // Attempting to import cfWorkerProvider should fail
            await expect(import('../../src/validators/cfWorkerProvider')).rejects.toThrow();
        });

        it('should be able to import ajv-provider when @cfworker/json-schema is missing', async () => {
            // Mock @cfworker/json-schema as not installed
            vi.doMock('@cfworker/json-schema', () => {
                throw new Error("Cannot find module '@cfworker/json-schema'");
            });

            // But ajv-provider should import successfully
            const ajvModule = await import('../../src/validators/ajvProvider');
            expect(ajvModule.AjvJsonSchemaValidator).toBeDefined();

            // And should work correctly
            const validator = new ajvModule.AjvJsonSchemaValidator();
            const schema: JsonSchemaType = { type: 'string' };
            const validatorFn = validator.getValidator(schema);
            expect(validatorFn('test').valid).toBe(true);
        });

        it('should document that @cfworker/json-schema is required', () => {
            const cfworkerProviderPath = path.join(__dirname, '../../src/validators/cfWorkerProvider.ts');
            const content = readFileSync(cfworkerProviderPath, 'utf8');

            expect(content).toContain('@cfworker/json-schema');
        });
    });
});

/**
 * The spec honors a schema's declared `$schema` dialect (absent means 2020-12 per SEP-1613).
 * The built-in providers dispatch: no `$schema` / 2020-12 → the 2020-12 engine; draft-07 /
 * draft-06 → a draft-07 engine (draft-07's changes over draft-06 are additive). Any other
 * declared dialect is rejected with a clear `Error`. The escape hatch is the existing
 * custom-engine constructor (caller-supplied Ajv instance / explicit `{draft}`).
 *
 * Discriminators: `prefixItems` is a 2020-12 keyword the draft-07 engines silently ignore
 * under lenient options, and the positional `items` array is draft-07's tuple form —
 * together they prove which engine ran, not merely that compile stopped throwing.
 */
describe('$schema dialect dispatch', () => {
    const DRAFT_07_URI = 'http://json-schema.org/draft-07/schema#';
    const DRAFT_2020_URI = 'https://json-schema.org/draft/2020-12/schema';
    const prefixItemsSchema = ($schema?: string): JsonSchemaType => ({
        ...($schema ? { $schema } : {}),
        type: 'array',
        prefixItems: [{ type: 'number' }, { type: 'string' }]
    });
    /** Violates `prefixItems` (positions swapped). */
    const PREFIX_ITEMS_BAD: unknown = ['x', 1];
    /** Draft-07 tuple form (positional `items` array — not representable in the 2020-12-shaped type). */
    const tupleItemsSchema = ($schema: string): JsonSchemaType =>
        ({
            $schema,
            type: 'array',
            items: [{ type: 'number' }, { type: 'string' }]
        }) as unknown as JsonSchemaType;

    describe.each(validators)('$name', ({ provider }) => {
        it('default → Ajv2020 / 2020-12 (prefixItems is enforced)', () => {
            const v = provider.getValidator(prefixItemsSchema());
            expect(v(PREFIX_ITEMS_BAD).valid).toBe(false);
            expect(v([1, 'x']).valid).toBe(true);
        });

        it('$schema: 2020-12 → compiles, prefixItems enforced', () => {
            const v = provider.getValidator(prefixItemsSchema(DRAFT_2020_URI));
            expect(v(PREFIX_ITEMS_BAD).valid).toBe(false);
        });

        it.each([
            ['draft-07 http, trailing #', 'http://json-schema.org/draft-07/schema#'],
            ['draft-07 https, no #', 'https://json-schema.org/draft-07/schema'],
            ['draft-06 http', 'http://json-schema.org/draft-06/schema#'],
            ['draft-06 https', 'https://json-schema.org/draft-06/schema'],
            ['2019-09 https, trailing #', 'https://json-schema.org/draft/2019-09/schema#'],
            ['2019-09 http', 'http://json-schema.org/draft/2019-09/schema']
        ])('$schema %s → declared-dialect tuple semantics on `items`', (_label, uri) => {
            const v = provider.getValidator(tupleItemsSchema(uri));
            expect(v([1, 'x']).valid).toBe(true);
            expect(v(['x', 1]).valid).toBe(false);
        });

        it.each([
            ['draft-04', 'http://json-schema.org/draft-04/schema#'],
            ['version-less alias', 'http://json-schema.org/schema#'],
            ['garbage', 'https://example.com/my-dialect']
        ])('$schema %s → graceful Error listing supported dialects', (_label, uri) => {
            expect(() => provider.getValidator(prefixItemsSchema(uri))).toThrow(
                /unsupported dialect.*2020-12, 2019-09, draft-07, and draft-06/s
            );
        });
    });

    // The shared classifier is what both providers dispatch on — pinning it directly covers
    // the CfWorker side, whose engine applies both keyword sets in either draft mode (so the
    // dispatch is not observable through validation results there).
    describe('declaredDialect classifier', () => {
        it.each([
            ['absent', undefined],
            ['https', 'https://json-schema.org/draft/2020-12/schema'],
            ['http, trailing #', 'http://json-schema.org/draft/2020-12/schema#']
        ])('%s → 2020-12', (_label, uri) => {
            expect(declaredDialect({ ...(uri ? { $schema: uri } : {}), type: 'object' }, 'r')).toBe('2020-12');
        });

        it.each([
            ['https, trailing #', 'https://json-schema.org/draft/2019-09/schema#'],
            ['http', 'http://json-schema.org/draft/2019-09/schema']
        ])('2019-09 %s → 2019-09', (_label, uri) => {
            expect(declaredDialect({ $schema: uri, type: 'object' }, 'r')).toBe('2019-09');
        });

        it.each([
            ['draft-07 http #', 'http://json-schema.org/draft-07/schema#'],
            ['draft-07 https', 'https://json-schema.org/draft-07/schema'],
            ['draft-06 http #', 'http://json-schema.org/draft-06/schema#'],
            ['draft-06 https', 'https://json-schema.org/draft-06/schema']
        ])('%s → draft-7', (_label, uri) => {
            expect(declaredDialect({ $schema: uri, type: 'object' }, 'r')).toBe('draft-7');
        });

        it('unknown → throws with the remedy appended', () => {
            expect(() => declaredDialect({ $schema: 'https://example.com/dialect', type: 'object' }, 'REMEDY.')).toThrow(
                /unsupported dialect.*2020-12, 2019-09, draft-07, and draft-06; REMEDY\.$/s
            );
        });
    });

    it('AJV: declared 2019-09 selects Ajv2019 (unevaluatedProperties enforced, tuple items compiles)', () => {
        // Pins the engine against both wrong-engine mutations: Ajv2020 would reject the
        // `items` array form at compile, and classic Ajv ignores `unevaluatedProperties`.
        // (No CfWorker leg: @cfworker/json-schema applies both keyword sets in every draft mode.)
        const v = new AjvJsonSchemaValidator().getValidator({
            $schema: 'https://json-schema.org/draft/2019-09/schema',
            type: 'object',
            properties: { pair: { type: 'array', items: [{ type: 'number' }, { type: 'string' }] } },
            unevaluatedProperties: false
        } as unknown as JsonSchemaType);
        expect(v({ pair: [1, 'x'] }).valid).toBe(true);
        expect(v({ pair: ['x', 1] }).valid).toBe(false); // tuple semantics live
        expect(v({ pair: [1, 'x'], extra: 1 }).valid).toBe(false); // 2019-09 keyword enforced
    });

    it('recorded contract: the engines DIVERGE on $ref siblings under draft-07', () => {
        // Draft-07 says keywords adjacent to $ref MUST be ignored. Classic Ajv (v8)
        // evaluates them anyway — non-configurable, and identical to v1's default
        // engine — while @cfworker follows the spec. This test records that known
        // difference so a dependency bump that changes either side is caught.
        const schema: JsonSchemaType = {
            $schema: DRAFT_07_URI,
            type: 'object',
            definitions: { name: { type: 'string' } },
            properties: { a: { $ref: '#/definitions/name', maxLength: 2 } },
            required: ['a']
        } as unknown as JsonSchemaType;
        const data = { a: 'hello' };

        // Node engine: maxLength next to $ref is enforced → rejected (stricter than spec).
        expect(new AjvJsonSchemaValidator().getValidator(schema)(data).valid).toBe(false);
        // cfworker engine: sibling ignored per draft-07 → accepted.
        expect(new CfWorkerJsonSchemaValidator().getValidator(schema)(data).valid).toBe(true);
    });

    it('AJV: declared draft-07 selects the draft-07 ENGINE (prefixItems ignored, items enforced)', () => {
        // Contradictory keywords: under the classic engine the `items` tuple wins and
        // `prefixItems` is unknown; `Ajv2020` would enforce `prefixItems` and reject the `items`
        // array form at compile — so [1,'x'] passing pins the engine. (No CfWorker leg:
        // @cfworker/json-schema applies both keyword sets in either draft mode.)
        const v = new AjvJsonSchemaValidator().getValidator({
            $schema: DRAFT_07_URI,
            type: 'array',
            items: [{ type: 'number' }, { type: 'string' }],
            prefixItems: [{ type: 'string' }, { type: 'number' }]
        } as unknown as JsonSchemaType);
        expect(v([1, 'x']).valid).toBe(true);
        expect(v(['x', 1]).valid).toBe(false);
    });

    it('AJV: custom Ajv instance bypasses the $schema check (caller owns dialect)', () => {
        // A draft-07 Ajv passed explicitly: even with `$schema: draft-07`, the provider does not
        // throw — and `prefixItems` is unknown to draft-07 Ajv and silently ignored.
        const draft07 = new Ajv({ strict: false, validateSchema: false, allErrors: true });
        const custom = new AjvJsonSchemaValidator(draft07);
        const v = custom.getValidator(prefixItemsSchema(DRAFT_07_URI));
        expect(v(PREFIX_ITEMS_BAD).valid).toBe(true);
    });

    it('CfWorker: explicit {draft} bypasses the $schema check (caller owns dialect)', () => {
        const custom = new CfWorkerJsonSchemaValidator({ draft: '7' });
        expect(() => custom.getValidator(prefixItemsSchema(DRAFT_07_URI))).not.toThrow();
    });
});
