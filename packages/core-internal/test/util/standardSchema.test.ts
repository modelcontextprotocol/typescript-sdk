import * as z from 'zod/v4';

import { standardSchemaToJsonSchema } from '../../src/util/standardSchema';

describe('standardSchemaToJsonSchema', () => {
    test('emits type:object for plain z.object schemas', () => {
        const schema = z.object({ name: z.string(), age: z.number() });
        const result = standardSchemaToJsonSchema(schema, 'input');

        expect(result.type).toBe('object');
        expect(result.properties).toBeDefined();
    });

    test('closes plain object input schemas', () => {
        const schema = z.object({ name: z.string() });
        const result = standardSchemaToJsonSchema(schema, 'input', { closeZodInputObjects: true });

        expect(result.additionalProperties).toBe(false);
    });

    test('preserves default object conversion semantics', () => {
        const schema = z.object({ name: z.string() });
        const result = standardSchemaToJsonSchema(schema, 'input');

        expect(result.additionalProperties).toBeUndefined();
    });

    test('preserves explicit open object schemas', () => {
        const schema = z.looseObject({ value: z.string() });
        const result = standardSchemaToJsonSchema(schema, 'input');

        expect(result.additionalProperties).toEqual({});
    });

    test('preserves union compositions without adding a root default', () => {
        const schema = z.discriminatedUnion('action', [
            z.object({ action: z.literal('create'), name: z.string() }),
            z.object({ action: z.literal('delete'), id: z.string() })
        ]);
        const result = standardSchemaToJsonSchema(schema, 'input');
        const members = result.oneOf as Array<Record<string, unknown>>;

        expect(result.additionalProperties).toBeUndefined();
        expect(members.every(member => member.additionalProperties === undefined)).toBe(true);
    });

    test('leaves non-Zod and output object schemas unchanged', () => {
        const schema = {
            '~standard': {
                version: 1,
                vendor: 'test',
                validate: (value: unknown) => ({ value }),
                jsonSchema: {
                    input: () => ({ type: 'object' }),
                    output: () => ({ type: 'object' })
                }
            }
        } as never;
        const inputResult = standardSchemaToJsonSchema(schema, 'input');
        const result = standardSchemaToJsonSchema(schema, 'output');

        expect(inputResult.additionalProperties).toBeUndefined();
        expect(result.additionalProperties).toBeUndefined();
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
