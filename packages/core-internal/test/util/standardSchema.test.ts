import * as z from 'zod/v4';

import { type StandardSchemaV1, standardSchemaToJsonSchema, validateStandardSchema } from '../../src/util/standardSchema';

describe('validateStandardSchema', () => {
    test.each(['synchronous', 'asynchronous'] as const)('rejects %s failures with an empty issues array', async mode => {
        const schema: StandardSchemaV1 = {
            '~standard': {
                version: 1,
                vendor: 'empty-issues',
                validate: () => (mode === 'asynchronous' ? Promise.resolve({ issues: [] }) : { issues: [] })
            }
        };

        await expect(validateStandardSchema(schema, { name: 'example' })).resolves.toEqual({ success: false, error: '' });
    });

    test('preserves transformed values when validation succeeds', async () => {
        const schema = z.string().transform(value => value.toUpperCase());

        await expect(validateStandardSchema(schema, 'hello')).resolves.toEqual({ success: true, data: 'HELLO' });
    });

    test('preserves undefined when validation succeeds', async () => {
        await expect(validateStandardSchema(z.undefined(), undefined)).resolves.toEqual({ success: true, data: undefined });
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
