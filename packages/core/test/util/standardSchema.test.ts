import * as z from 'zod/v4';

import { standardSchemaToJsonSchema } from '../../src/util/standardSchema.js';

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

    // SEP-2106 / R-2106-7: a tool's `outputSchema` may be any valid JSON Schema 2020-12 — arrays,
    // primitives, or compositions — so the `io: 'output'` branch must return the converted schema
    // unchanged, never forcing (or rejecting based on) a root `type: 'object'`.
    describe("io: 'output' (SEP-2106 outputSchema)", () => {
        test('returns a non-object root unchanged (array)', () => {
            const result = standardSchemaToJsonSchema(z.array(z.number()), 'output');

            expect(result.type).toBe('array');
            expect(result.items).toBeDefined();
        });

        test('returns a primitive root unchanged (number)', () => {
            const result = standardSchemaToJsonSchema(z.number(), 'output');

            expect(result.type).toBe('number');
        });

        test('does not force type:object onto an object output schema', () => {
            const result = standardSchemaToJsonSchema(z.object({ x: z.string() }), 'output');

            const keys = Object.keys(result);
            expect(keys.filter(k => k === 'type')).toHaveLength(1);
            expect(result.type).toBe('object');
        });

        test('does not throw for a non-object type (unlike input)', () => {
            expect(() => standardSchemaToJsonSchema(z.string(), 'output')).not.toThrow();
            expect(() => standardSchemaToJsonSchema(z.array(z.string()), 'output')).not.toThrow();
        });
    });
});
