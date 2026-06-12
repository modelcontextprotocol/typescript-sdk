import * as z from 'zod/v4';

import { standardSchemaToJsonSchema, type StandardJSONSchemaV1 } from '../../src/util/standardSchema.js';

/**
 * Walk a JSON Schema-shaped value and collect every `$ref` string it contains.
 * Used to assert the SDK never emits `$ref` keys regardless of nesting depth.
 */
function collectRefs(value: unknown, refs: string[] = []): string[] {
    if (value == null || typeof value !== 'object') return refs;
    if (Array.isArray(value)) {
        for (const v of value) collectRefs(v, refs);
        return refs;
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (k === '$ref' && typeof v === 'string') refs.push(v);
        collectRefs(v, refs);
    }
    return refs;
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

    describe('$ref behavior for reused schemas (issue #2100)', () => {
        test('inlines an anonymous reused object referenced by two fields', () => {
            const Address = z.object({ street: z.string(), city: z.string() });
            const schema = z.object({ shipping: Address, billing: Address });

            const result = standardSchemaToJsonSchema(schema, 'input');

            expect(collectRefs(result)).toEqual([]);
        });

        test('inlines a reused object referenced inside an array', () => {
            const Address = z.object({ street: z.string(), city: z.string() });
            const schema = z.object({ primary: Address, history: z.array(Address) });

            const result = standardSchemaToJsonSchema(schema, 'input');

            expect(collectRefs(result)).toEqual([]);
        });

        test('inlines reused objects inside a discriminated union', () => {
            const Address = z.object({ street: z.string(), city: z.string() });
            const schema = z.discriminatedUnion('kind', [
                z.object({ kind: z.literal('ship'), address: Address }),
                z.object({ kind: z.literal('bill'), address: Address })
            ]);

            const result = standardSchemaToJsonSchema(schema, 'input');

            expect(collectRefs(result)).toEqual([]);
        });

        test('control: forcing reused:ref via libraryOptions does produce $refs (proves SDK pins inline)', () => {
            // Defensive lock-in: even if a caller bypasses the SDK and forces zod into
            // ref-mode, we want a witness that ref-mode is in fact reachable. This
            // guards against the test above passing accidentally because zod silently
            // dropped support for the option.
            const Address = z.object({ street: z.string(), city: z.string() });
            const schema = z.object({ shipping: Address, billing: Address });

            // Reach into the underlying StandardJSONSchemaV1 converter and pass the
            // ref-mode override directly. The SDK never threads this knob through, so
            // this only affects the witness call below.
            const std = (schema as unknown as StandardJSONSchemaV1)['~standard'];
            const refResult = std.jsonSchema.input({
                target: 'draft-2020-12',
                libraryOptions: { reused: 'ref' }
            });
            expect(collectRefs(refResult).length).toBeGreaterThan(0);

            // And the SDK's converter must still inline regardless.
            const sdkResult = standardSchemaToJsonSchema(schema, 'input');
            expect(collectRefs(sdkResult)).toEqual([]);
        });
    });
});
