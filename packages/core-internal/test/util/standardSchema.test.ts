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

describe('referenced output schemas', () => {
    const object = { type: 'object', properties: { value: { type: 'string' } } };
    const reference = { $ref: '#/$defs/Value' };
    const convert = (schema: Record<string, unknown>) =>
        standardSchemaToJsonSchema(
            {
                '~standard': {
                    version: 1,
                    vendor: 'test',
                    jsonSchema: { input: () => schema, output: () => schema }
                }
            },
            'output'
        );

    test.each([
        ['local object', { ...reference, $defs: { Value: object } }],
        ['root with an ID', { ...reference, $id: 'https://example.com/schema', $defs: { Value: object } }],
        ['reference chain', { ...reference, $defs: { Value: { $ref: '#/$defs/Object' }, Object: object } }],
        ['recursive object', { ...reference, $defs: { Value: { type: 'object', properties: { child: reference } } } }],
        ['repeated reference in a union', { anyOf: [reference, reference], $defs: { Value: object } }],
        ['referenced object union', { ...reference, $defs: { Value: { oneOf: [object, { type: 'object' }] } } }],
        ['escaped definition name', { $ref: '#/$defs/a~1b~0c%20d', $defs: { 'a/b~c d': object } }],
        ['draft-07 definitions', { $ref: '#/definitions/Value', definitions: { Value: object } }]
    ])('adds an object root for %s without changing the reference', (_name, schema) => {
        const original = JSON.parse(JSON.stringify(schema));
        expect(convert(schema as Record<string, unknown>)).toEqual({ type: 'object', ...original });
        expect(schema).toEqual(original);
    });

    test.each([
        ['string', { ...reference, $defs: { Value: { type: 'string' } } }],
        ['nullable object', { ...reference, $defs: { Value: { type: ['object', 'null'] } } }],
        ['mixed union', { anyOf: [reference, { type: 'string' }], $defs: { Value: object } }],
        ['missing target', { ...reference, $defs: {} }],
        ['external reference', { $ref: 'https://example.com/schema', $defs: { Value: object } }],
        ['anchor', { $ref: '#Value', $defs: { Value: { $anchor: 'Value', ...object } } }],
        ['direct cycle', { ...reference, $defs: { Value: reference } }],
        ['indirect cycle', { ...reference, $defs: { Value: { allOf: [reference] } } }],
        ['root cycle', { $ref: '#' }],
        ['boolean target', { ...reference, $defs: { Value: true } }],
        ['array target', { ...reference, $defs: { Value: [object] } }],
        ['malformed URI escape', { $ref: '#/$defs/%', $defs: { '%': object } }],
        ['malformed pointer escape', { $ref: '#/$defs/a~2b', $defs: { 'a~2b': object } }],
        ['inherited property', { $ref: '#/$defs/Value', $defs: Object.create({ Value: object }) }],
        [
            'reference in a nested resource',
            { ...reference, $defs: { Value: { $id: 'other.json', $ref: '#/$defs/Object' }, Object: object } }
        ],
        [
            'pointer crossing a nested resource',
            { $ref: '#/$defs/Value/$defs/Object', $defs: { Value: { $id: 'other.json', $defs: { Object: object } } } }
        ]
    ])('leaves %s unchanged when an object root cannot be established', (_name, schema) => {
        expect(convert(schema as Record<string, unknown>)).toBe(schema);
    });
});
