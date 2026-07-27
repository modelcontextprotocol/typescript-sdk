import * as z from 'zod/v4';

import { standardSchemaToJsonSchema } from '../../src/util/standardSchema';

describe('standardSchemaToJsonSchema', () => {
    test('emits type:object for plain z.object schemas', () => {
        const schema = z.object({ name: z.string(), age: z.number() });
        const result = standardSchemaToJsonSchema(schema, 'input');

        expect(result.type).toBe('object');
        expect(result.properties).toBeDefined();
    });

    test('emits type:object for discriminated unions', () => {
        const schema = z.discriminatedUnion('action', [
            z.object({ action: z.literal('create'), name: z.string() }),
            z.object({ action: z.literal('delete'), id: z.string() })
        ]);
        const result = standardSchemaToJsonSchema(schema, 'input');

        expect(result.type).toBe('object');
        // Zod emits oneOf for discriminated unions; the catchall on Tool.inputSchema
        // accepts it, but the top-level type must be present per MCP spec.
        expect(result.oneOf ?? result.anyOf).toBeDefined();
    });

    test('throws for schemas with explicit non-object type', () => {
        expect(() => standardSchemaToJsonSchema(z.string(), 'input')).toThrow(/must describe objects/);
        expect(() => standardSchemaToJsonSchema(z.array(z.string()), 'input')).toThrow(/must describe objects/);
        expect(() => standardSchemaToJsonSchema(z.number(), 'input')).toThrow(/must describe objects/);
    });

    test('preserves existing type:object without modification', () => {
        const schema = z.object({ x: z.string() });
        const result = standardSchemaToJsonSchema(schema, 'input');

        // Spread order means zod's own type:"object" wins; verify no double-wrap.
        const keys = Object.keys(result);
        expect(keys.filter(k => k === 'type')).toHaveLength(1);
        expect(result.type).toBe('object');
    });
});

describe('zod conversion options (#2464)', () => {
    test('z.date() converts to string/date-time instead of throwing (input)', () => {
        const result = standardSchemaToJsonSchema(z.object({ when: z.date() }), 'input');

        expect((result.properties as Record<string, unknown>).when).toEqual({ type: 'string', format: 'date-time' });
    });

    test('z.date() converts to string/date-time instead of throwing (output)', () => {
        const result = standardSchemaToJsonSchema(z.object({ when: z.date() }), 'output');

        expect((result.properties as Record<string, unknown>).when).toEqual({ type: 'string', format: 'date-time' });
    });

    test('other unrepresentable types degrade to an unconstrained schema instead of throwing', () => {
        const result = standardSchemaToJsonSchema(z.object({ big: z.bigint() }), 'input');

        expect((result.properties as Record<string, unknown>).big).toEqual({});
    });

    test('z.date() keeps user annotations alongside the rewritten wire shape', () => {
        const result = standardSchemaToJsonSchema(z.object({ when: z.date().describe('event timestamp') }), 'input');

        expect((result.properties as Record<string, unknown>).when).toEqual({
            type: 'string',
            format: 'date-time',
            description: 'event timestamp'
        });
    });

    test("unrepresentable: 'throw' restores zod's conversion error (elicitation contract)", () => {
        expect(() => standardSchemaToJsonSchema(z.object({ when: z.date() }), 'input', { unrepresentable: 'throw' })).toThrow(
            /Date cannot be represented/
        );
    });

    test('defaulted fields are not advertised as required in output schemas', () => {
        const schema = z.object({ counted: z.number().default(0), name: z.string() });
        const result = standardSchemaToJsonSchema(schema, 'output');

        // The server ships the tool's raw structuredContent without filling defaults,
        // so a payload omitting `counted` must satisfy the advertised schema.
        expect(result.required).toEqual(['name']);
    });

    test('a registered .default() (emitted as $ref) is still dropped from output required', () => {
        const schema = z.object({ counted: z.number().default(0).meta({ id: 'StandardSchemaTestCounted' }), name: z.string() });
        const result = standardSchemaToJsonSchema(schema, 'output');

        // The `default` keyword hides inside $defs behind a bare $ref; the filter must
        // key on the zod shape, not the emitted JSON.
        expect((result.properties as Record<string, Record<string, unknown>>).counted?.$ref).toBeDefined();
        expect(result.required).toEqual(['name']);
    });

    test('a required field annotated with .meta({default}) stays required in output schemas', () => {
        const schema = z.object({ label: z.string().meta({ default: 'n/a' }), other: z.number() });
        const result = standardSchemaToJsonSchema(schema, 'output');

        // The annotation carries a `default` keyword, but validation still requires the
        // field, so every shipped payload carries it.
        expect(result.required).toEqual(['label', 'other']);
    });

    test('undefined-accepting fields are not advertised as required in output schemas', () => {
        const schema = z.object({ a: z.any(), u: z.unknown(), v: z.undefined(), name: z.string() });
        const result = standardSchemaToJsonSchema(schema, 'output');

        // A raw payload with an undefined-valued key passes validation, and
        // JSON.stringify drops the key from the wire entirely.
        expect(result.required).toEqual(['name']);
    });

    test('plain z.object() output schemas do not advertise additionalProperties:false', () => {
        const result = standardSchemaToJsonSchema(z.object({ name: z.string() }), 'output');

        // zod validation passes unknown keys through on plain objects, so the raw
        // payload may carry extras the advertised schema must not forbid.
        expect(result.additionalProperties).toBeUndefined();
    });

    test('z.strictObject() output schemas keep additionalProperties:false', () => {
        const result = standardSchemaToJsonSchema(z.strictObject({ name: z.string() }), 'output');

        // Strict objects reject extras during validation, so the promise is kept.
        expect(result.additionalProperties).toBe(false);
    });
});
