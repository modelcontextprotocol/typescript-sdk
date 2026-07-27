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

    test('defaulted fields are not advertised as required in output schemas', () => {
        const schema = z.object({ counted: z.number().default(0), name: z.string() });
        const result = standardSchemaToJsonSchema(schema, 'output');

        // The server ships the tool's raw structuredContent without filling defaults,
        // so a payload omitting `counted` must satisfy the advertised schema.
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
