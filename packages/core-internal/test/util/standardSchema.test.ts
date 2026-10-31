import * as z from 'zod/v4';

import { standardSchemaToJsonSchema } from '../../src/util/standardSchema';

/** Patches `~standard.jsonSchema.input` with a counter (#3132: the prop is readonly in zod's types). */
function countInputConversions(schema: { '~standard': unknown }): () => number {
    let count = 0;
    const jsonSchema = (schema['~standard'] as { jsonSchema: Record<'input', (options: never) => unknown> }).jsonSchema;
    const original = jsonSchema.input;
    jsonSchema.input = (options: never) => {
        count++;
        return original(options);
    };
    return () => count;
}

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

    test('uses an already-converted toJSONSchema() document directly instead of re-converting', () => {
        const document = z.object({ a: z.string() }).toJSONSchema();
        const conversions = countInputConversions(document);

        const result = standardSchemaToJsonSchema(document, 'input');

        expect(conversions()).toBe(0);
        expect(result).toEqual({ type: 'object', ...document });
    });

    test('still converts a live zod schema carrying ~standard', () => {
        const schema = z.object({ a: z.string() });
        const conversions = countInputConversions(schema);

        const result = standardSchemaToJsonSchema(schema, 'input');

        expect(conversions()).toBe(1);
        expect(result.type).toBe('object');
        expect(result.properties).toEqual({ a: { type: 'string' } });
    });
});
