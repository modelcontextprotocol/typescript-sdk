import * as z from 'zod/v4';

import { isZodRawShape, normalizeRawShapeSchema, standardSchemaToJsonSchema } from '../../src/util/standardSchema.js';

describe('isZodRawShape', () => {
    test('treats empty object as a raw shape (matches v1)', () => {
        expect(isZodRawShape({})).toBe(true);
    });
    test('detects raw shape with zod fields', () => {
        expect(isZodRawShape({ a: z.string() })).toBe(true);
    });
    test('rejects a Standard Schema instance', () => {
        expect(isZodRawShape(z.object({ a: z.string() }))).toBe(false);
    });
});

describe('normalizeRawShapeSchema', () => {
    test('wraps empty raw shape into z.object({})', () => {
        const wrapped = normalizeRawShapeSchema({});
        expect(wrapped).toBeDefined();
        expect(standardSchemaToJsonSchema(wrapped!, 'input').type).toBe('object');
    });
});

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
