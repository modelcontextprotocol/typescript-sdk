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

    test('inlines local $ref from library-converted schemas (zod globalRegistry)', () => {
        const Address = z.object({ street: z.string(), city: z.string() });
        z.globalRegistry.add(Address, { id: 'Address' });
        try {
            const result = standardSchemaToJsonSchema(z.object({ home: Address, work: Address }), 'input');
            expect(JSON.stringify(result)).not.toContain('$ref');
            expect(result.$defs).toBeUndefined();
            const props = result.properties as Record<string, Record<string, unknown>>;
            expect(props.home?.type).toBe('object');
            expect(props.work?.type).toBe('object');
        } finally {
            z.globalRegistry.remove(Address);
        }
    });

    test('preserves $defs/$ref verbatim for hand-authored JSON Schema (vendor mcp)', () => {
        // SEP-1613: schemas registered via fromJsonSchema() are authorial intent and
        // must survive tools/list unchanged — the json-schema-2020-12 conformance
        // scenario asserts this round-trip. Only library-converted schemas (where
        // $ref is a conversion artifact) get dereferenced.
        const raw = {
            type: 'object',
            $defs: {
                address: { $anchor: 'addressDef', type: 'object', properties: { street: { type: 'string' } } }
            },
            properties: { name: { type: 'string' }, address: { $ref: '#/$defs/address' } },
            additionalProperties: false
        };
        // Same shape fromJsonSchema() produces (vendor 'mcp', verbatim input/output).
        const handAuthored = {
            '~standard': {
                version: 1,
                vendor: 'mcp',
                jsonSchema: { input: () => raw, output: () => raw },
                validate: (value: unknown) => ({ value })
            }
        };
        const result = standardSchemaToJsonSchema(handAuthored as never, 'input');
        expect(result.$defs).toEqual(raw.$defs);
        expect((result.properties as Record<string, unknown>).address).toEqual({ $ref: '#/$defs/address' });
        expect(result.additionalProperties).toBe(false);
    });
});
