/**
 * The multi-round-trip authoring helpers (M4.1): the `inputRequired()`
 * builder family, the `acceptedContent` reader, and the `withInputRequired`
 * manual-mode schema wrapper. No nominal brand exists — the builder returns a
 * plain `resultType: 'input_required'` value (F-10).
 */
import { describe, expect, test } from 'vitest';
import * as z from 'zod/v4';

import { acceptedContent, inputRequired, withInputRequired } from '../../src/shared/inputRequired';
import { isInputRequiredResult } from '../../src/types/guards';
import { validateStandardSchema } from '../../src/util/standardSchema';

describe('inputRequired() builder', () => {
    test('builds a plain discriminated value (no brand) from inputRequests', () => {
        const value = inputRequired({
            inputRequests: { confirm: inputRequired.elicit({ message: 'OK?', requestedSchema: { type: 'object', properties: {} } }) }
        });
        expect(value.resultType).toBe('input_required');
        expect(Object.getOwnPropertySymbols(value)).toEqual([]);
        expect(isInputRequiredResult(value)).toBe(true);
        expect(value.inputRequests?.confirm).toMatchObject({ method: 'elicitation/create', params: { mode: 'form', message: 'OK?' } });
        expect(value.requestState).toBeUndefined();
    });

    test('builds a requestState-only value (load shedding)', () => {
        const value = inputRequired({ requestState: 'opaque-blob' });
        expect(value).toEqual({ resultType: 'input_required', requestState: 'opaque-blob' });
    });

    test('enforces the at-least-one rule', () => {
        expect(() => inputRequired({})).toThrow(TypeError);
        expect(() => inputRequired({ inputRequests: {} })).toThrow(/at least one/);
    });

    test('hand-built literals discriminate identically (hand-built results are legal)', () => {
        expect(isInputRequiredResult({ resultType: 'input_required', requestState: 's' })).toBe(true);
        expect(isInputRequiredResult({ resultType: 'complete' })).toBe(false);
        expect(isInputRequiredResult({ content: [] })).toBe(false);
        expect(isInputRequiredResult(null)).toBe(false);
    });

    test('per-kind constructors produce the embedded request shapes', () => {
        expect(inputRequired.elicitUrl({ message: 'go', url: 'https://example.com/auth' })).toEqual({
            method: 'elicitation/create',
            params: { mode: 'url', message: 'go', url: 'https://example.com/auth' }
        });
        expect(inputRequired.createMessage({ messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }], maxTokens: 5 })).toEqual({
            method: 'sampling/createMessage',
            params: { messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }], maxTokens: 5 }
        });
        expect(inputRequired.listRoots()).toEqual({ method: 'roots/list' });
    });

    test('elicit converts a Standard Schema to the restricted wire schema', () => {
        const request = inputRequired.elicit({
            message: 'Registration details?',
            requestedSchema: z.object({
                email: z.email().meta({ title: 'Email' }),
                count: z.number().min(1).max(5),
                role: z.enum(['admin', 'member'])
            })
        });

        expect(request).toEqual({
            method: 'elicitation/create',
            params: {
                mode: 'form',
                message: 'Registration details?',
                requestedSchema: {
                    $schema: 'https://json-schema.org/draft/2020-12/schema',
                    type: 'object',
                    properties: {
                        email: { type: 'string', title: 'Email', format: 'email' },
                        count: { type: 'number', minimum: 1, maximum: 5 },
                        role: { type: 'string', enum: ['admin', 'member'] }
                    },
                    required: ['email', 'count', 'role']
                }
            }
        });
    });

    test('elicit drops annotation-only metadata from Standard Schema properties', () => {
        const request = inputRequired.elicit({
            message: 'Name?',
            requestedSchema: z.object({
                name: z.string().meta({
                    title: 'Name',
                    examples: ['Ada Lovelace'],
                    deprecated: false,
                    readOnly: true,
                    'x-ui-order': 1
                })
            })
        });

        expect(request).toEqual({
            method: 'elicitation/create',
            params: {
                mode: 'form',
                message: 'Name?',
                requestedSchema: {
                    $schema: 'https://json-schema.org/draft/2020-12/schema',
                    type: 'object',
                    properties: { name: { type: 'string', title: 'Name' } },
                    required: ['name']
                }
            }
        });
    });

    test('elicit rejects non-object Standard Schema roots as a local type error', () => {
        expect(() =>
            inputRequired.elicit({
                message: 'Name?',
                requestedSchema: z.string()
            })
        ).toThrow(TypeError);
        expect(() =>
            inputRequired.elicit({
                message: 'Name?',
                requestedSchema: z.string()
            })
        ).toThrow(/Elicitation requestedSchema must describe an object/);
    });

    test('elicit rejects validation constraints the restricted wire schema cannot express', () => {
        const rejectPattern = () =>
            inputRequired.elicit({
                message: 'Code?',
                requestedSchema: z.object({ code: z.string().regex(/^[A-Z]{3}$/) })
            });
        expect(rejectPattern).toThrow(TypeError);
        expect(rejectPattern).toThrow(/properties\.code\.pattern/);

        expect(() =>
            inputRequired.elicit({
                message: 'Address?',
                requestedSchema: z.object({ address: z.object({ city: z.string() }) })
            })
        ).toThrow(/flat primitive properties/);

        // A customized pattern layered on a format cannot ride the wire; silently sending
        // `format` alone would weaken the advertised constraint, so it rejects.
        expect(() =>
            inputRequired.elicit({
                message: 'Email?',
                requestedSchema: z.object({ email: z.email({ pattern: /@corp\.com$/ }) })
            })
        ).toThrow(/properties\.email\.pattern/);

        // Literal unions are the idiomatic zod spelling of an enum, but they convert to
        // `anyOf`/`const`, which matches no wire enum variant — pinned so a change here
        // surfaces in CI rather than user reports. (`z.literal(['a', 'b'])` and `z.enum`
        // both convert fine.)
        expect(() =>
            inputRequired.elicit({
                message: 'Role?',
                requestedSchema: z.object({ role: z.union([z.literal('admin'), z.literal('member')]) })
            })
        ).toThrow(TypeError);
    });

    test.each([
        ['z.email()', z.email(), 'email'],
        ['z.url()', z.url(), 'uri'],
        ['z.iso.date()', z.iso.date(), 'date'],
        ['z.iso.datetime()', z.iso.datetime(), 'date-time'],
        ['z.iso.datetime({ offset: true, precision: 3 })', z.iso.datetime({ offset: true, precision: 3 }), 'date-time'],
        ['z.string().meta({ format: "email" }) (annotation-only format)', z.string().meta({ format: 'email' }), 'email']
    ])('elicit keeps the %s format and drops the zod-emitted pattern', (_label, fieldSchema, format) => {
        const request = inputRequired.elicit({
            message: 'Value?',
            requestedSchema: z.object({ value: fieldSchema })
        });

        const valueSchema = (request.params as { requestedSchema: { properties: Record<string, Record<string, unknown>> } }).requestedSchema
            .properties.value!;
        expect(valueSchema.format).toBe(format);
        expect(valueSchema.pattern).toBeUndefined();
    });

    test('elicit keeps multi-select enums, optional fields, and defaults, and drops annotations the wire cannot place', () => {
        const request = inputRequired.elicit({
            message: 'Preferences?',
            requestedSchema: z.object({
                roles: z.array(z.enum(['admin', 'member']).meta({ title: 'Role' })),
                plan: z.literal(['free', 'pro']),
                nickname: z.string().optional(),
                newsletter: z.boolean().default(false)
            })
        });

        expect((request.params as { requestedSchema: unknown }).requestedSchema).toEqual({
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            properties: {
                roles: { type: 'array', items: { type: 'string', enum: ['admin', 'member'] } },
                plan: { type: 'string', enum: ['free', 'pro'] },
                nickname: { type: 'string' },
                newsletter: { type: 'boolean', default: false }
            },
            required: ['roles', 'plan']
        });
    });

    test("elicit trusts a non-zod vendor's format-companion pattern and drops it", () => {
        // ArkType's `string.email` bakes in its own format regex; without vendor
        // knowledge a companion pattern beside the retained format is the library's
        // realization of it, not a customization.
        const arkTypeLike = {
            '~standard': {
                version: 1,
                vendor: 'arktype',
                validate: (value: unknown) => ({ value }),
                jsonSchema: {
                    input: () => ({
                        type: 'object',
                        properties: {
                            email: { type: 'string', format: 'email', pattern: String.raw`^[\w%+.-]+@[\d.A-Za-z-]+\.[A-Za-z]{2,}$` }
                        },
                        required: ['email']
                    }),
                    output: () => ({})
                }
            }
        };
        const request = inputRequired.elicit({ message: 'Email?', requestedSchema: arkTypeLike as never });
        const emailSchema = (request.params as { requestedSchema: { properties: Record<string, Record<string, unknown>> } }).requestedSchema
            .properties.email!;
        expect(emailSchema.format).toBe('email');
        expect(emailSchema.pattern).toBeUndefined();
    });

    test('elicit rejects schemas whose converted required entries have no matching property', () => {
        // zod's toJSONSchema loses a `__proto__` property from `properties` while still
        // listing it in `required` — reject rather than ship the corrupt schema.
        const act = () =>
            inputRequired.elicit({
                message: 'Name?',
                requestedSchema: z.object({ ['__proto__']: z.string() })
            });
        expect(act).toThrow(TypeError);
        expect(act).toThrow(/required properties that are not defined/);
    });

    test('elicit keeps unknown params extension keys on both branches', () => {
        const rawRequest = inputRequired.elicit({
            message: 'OK?',
            requestedSchema: { type: 'object', properties: {} },
            myExtension: 'keep-me'
        } as never);
        const convertedRequest = inputRequired.elicit({
            message: 'OK?',
            requestedSchema: z.object({}),
            myExtension: 'keep-me'
        } as never);

        expect((rawRequest.params as { myExtension?: string }).myExtension).toBe('keep-me');
        expect((convertedRequest.params as { myExtension?: string }).myExtension).toBe('keep-me');
    });

    test('elicit rejects root keywords outside the spec requestedSchema shape', () => {
        const act = () =>
            inputRequired.elicit({
                message: 'Name?',
                requestedSchema: z.strictObject({ name: z.string() })
            });
        expect(act).toThrow(TypeError);
        expect(act).toThrow(/unsupported JSON Schema constraint\(s\).*additionalProperties/);

        expect(() =>
            inputRequired.elicit({
                message: 'Name?',
                requestedSchema: {
                    '~standard': {
                        version: 1,
                        vendor: 'test',
                        validate: (value: unknown) => ({ value }),
                        jsonSchema: {
                            input: () => ({
                                $defs: { Name: { type: 'string' } },
                                type: 'object',
                                properties: { name: { $ref: '#/$defs/Name' } },
                                required: ['name']
                            }),
                            output: () => ({})
                        }
                    }
                } as never
            })
        ).toThrow(/\$defs/);
    });

    test('elicit drops annotation-only root keywords', () => {
        const request = inputRequired.elicit({
            message: 'Name?',
            requestedSchema: z.object({ name: z.string() }).meta({ title: 'User', description: 'User info' })
        });

        expect((request.params as { requestedSchema: unknown }).requestedSchema).toEqual({
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name']
        });
    });

    test('elicit converts function-typed Standard Schemas (ArkType-style)', () => {
        const jsonSchema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
        const functionSchema = Object.assign(() => {}, {
            '~standard': {
                version: 1 as const,
                vendor: 'test',
                validate: (value: unknown) => ({ value }),
                jsonSchema: { input: () => jsonSchema, output: () => ({}) }
            }
        });

        const request = inputRequired.elicit({ message: 'Name?', requestedSchema: functionSchema as never });
        expect((request.params as { requestedSchema: unknown }).requestedSchema).toEqual(jsonSchema);
    });

    test('elicit converts validate-only schemas via the converter rather than the raw branch', () => {
        // Simulates zod before 4.2 (validate without `~standard.jsonSchema`): routing must
        // go to the converter, which owns per-vendor handling — a non-zod vendor without
        // jsonSchema fails closed there instead of shipping the schema object on the wire.
        const validateOnly = {
            '~standard': {
                version: 1,
                vendor: 'not-zod',
                validate: (value: unknown) => ({ value })
            }
        };
        const act = () => inputRequired.elicit({ message: 'Name?', requestedSchema: validateOnly as never });
        expect(act).toThrow(TypeError);
        expect(act).toThrow(/does not implement StandardJSONSchemaV1/);
    });

    test('elicit passes a plain JSON schema containing a literal "~standard" key through the raw branch', () => {
        const rawSchema = {
            type: 'object' as const,
            properties: { name: { type: 'string' as const } },
            '~standard': 'extension-data'
        };
        const request = inputRequired.elicit({ message: 'Name?', requestedSchema: rawSchema as never });
        expect((request.params as { requestedSchema: unknown }).requestedSchema).toBe(rawSchema);
    });

    test('elicit rejects a property type shadowing an Object.prototype member with the normal message', () => {
        const schema = {
            '~standard': {
                version: 1,
                vendor: 'test',
                validate: (value: unknown) => ({ value }),
                jsonSchema: {
                    input: () => ({ type: 'object', properties: { x: { type: 'constructor' } }, required: ['x'] }),
                    output: () => ({})
                }
            }
        };
        expect(() => inputRequired.elicit({ message: 'x', requestedSchema: schema as never })).toThrow(
            /flat primitive properties.*properties\.x/
        );
    });
});

describe('acceptedContent()', () => {
    test('returns the accepted form content for the key', () => {
        const responses = { confirm: { action: 'accept', content: { confirm: true } } };
        expect(acceptedContent<{ confirm: boolean }>(responses, 'confirm')).toEqual({ confirm: true });
    });

    test('returns undefined for missing keys, declined/cancelled responses, and other kinds', () => {
        expect(acceptedContent(undefined, 'confirm')).toBeUndefined();
        expect(acceptedContent({}, 'confirm')).toBeUndefined();
        expect(acceptedContent({ confirm: { action: 'decline' } }, 'confirm')).toBeUndefined();
        expect(acceptedContent({ confirm: { action: 'cancel' } }, 'confirm')).toBeUndefined();
        expect(acceptedContent({ confirm: { action: 'accept' } }, 'confirm')).toBeUndefined();
        expect(acceptedContent({ roots: { roots: [] } }, 'roots')).toBeUndefined();
    });
});

describe('withInputRequired()', () => {
    const inner = z.object({ content: z.array(z.unknown()) });

    test('passes input-required values through untouched', async () => {
        const wrapped = withInputRequired(inner);
        const value = { resultType: 'input_required', requestState: 'blob' };
        const outcome = await validateStandardSchema(wrapped, value);
        expect(outcome).toEqual({ success: true, data: value });
    });

    test('validates complete results against the wrapped schema', async () => {
        const wrapped = withInputRequired(inner);
        const ok = await validateStandardSchema(wrapped, { content: [] });
        expect(ok.success).toBe(true);
        const bad = await validateStandardSchema(wrapped, { nope: true });
        expect(bad.success).toBe(false);
    });
});
