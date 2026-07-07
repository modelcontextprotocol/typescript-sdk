import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';

import { addRequiredToExhaustiveRecords, standardSchemaToJsonSchema } from '../../src/util/standardSchema';

type SchemaArg = Parameters<typeof standardSchemaToJsonSchema>[0];

/**
 * Simulates zod 4.0–4.1 on a real zod 4 schema instance: shadows `~standard` with
 * `jsonSchema` removed so standardSchemaToJsonSchema takes the z.toJSONSchema fallback.
 * (Same technique as standardSchema.zodFallback.test.ts.)
 */
function withoutStandardJsonSchema(schema: z.ZodType): SchemaArg {
    const { jsonSchema: _drop, ...stdNoJson } = schema['~standard'] as unknown as Record<string, unknown>;
    void _drop;
    Object.defineProperty(schema, '~standard', { value: { ...stdNoJson, vendor: 'zod' }, configurable: true });
    return schema as unknown as SchemaArg;
}

/** The `required`-less record emission zod 4.0.x–4.2.x produces for enum-keyed records. */
function gapRecordJson(keys: string[]): Record<string, unknown> {
    return {
        type: 'object',
        propertyNames: { type: 'string', enum: [...keys] },
        additionalProperties: { type: 'number' }
    };
}

describe('addRequiredToExhaustiveRecords', () => {
    it('adds required for an exhaustive enum-keyed record (zod 4.0–4.2 emission gap)', () => {
        const schema = z.record(z.enum(['a', 'b']), z.number());
        const json = gapRecordJson(['a', 'b']);
        addRequiredToExhaustiveRecords(schema, json);
        expect(json.required).toEqual(['a', 'b']);
    });

    it('does NOT add required for z.partialRecord, whose emission is byte-identical', () => {
        const schema = z.partialRecord(z.enum(['a', 'b']), z.number());
        const json = gapRecordJson(['a', 'b']);
        addRequiredToExhaustiveRecords(schema, json);
        expect(json.required).toBeUndefined();
    });

    it('adds required for literal-union keys emitted as anyOf of consts', () => {
        const schema = z.record(z.union([z.literal('x'), z.literal('y')]), z.string());
        const json = {
            type: 'object',
            propertyNames: {
                anyOf: [
                    { type: 'string', const: 'x' },
                    { type: 'string', const: 'y' }
                ]
            },
            additionalProperties: { type: 'string' }
        } as Record<string, unknown>;
        addRequiredToExhaustiveRecords(schema, json);
        expect(json.required).toEqual(['x', 'y']);
    });

    it('patches a record nested inside an object, leaving the parent alone', () => {
        const schema = z.object({ limits: z.record(z.enum(['cpu', 'mem']), z.number()) });
        const json = {
            type: 'object',
            properties: { limits: gapRecordJson(['cpu', 'mem']) },
            required: ['limits'],
            additionalProperties: false
        } as Record<string, unknown>;
        addRequiredToExhaustiveRecords(schema, json);
        expect((json.properties as Record<string, Record<string, unknown>>).limits!.required).toEqual(['cpu', 'mem']);
        expect(json.required).toEqual(['limits']);
    });

    it('leaves nodes that already carry required untouched (no-op on zod >=4.3 emissions)', () => {
        const schema = z.record(z.enum(['a', 'b']), z.number());
        const json = { ...gapRecordJson(['a', 'b']), required: ['b', 'a'] };
        addRequiredToExhaustiveRecords(schema, json);
        expect(json.required).toEqual(['b', 'a']);
    });

    it('ignores open records (string keys) — no finite key set, no required', () => {
        const schema = z.record(z.string(), z.number());
        const json = {
            type: 'object',
            propertyNames: { type: 'string' },
            additionalProperties: { type: 'number' }
        } as Record<string, unknown>;
        addRequiredToExhaustiveRecords(schema, json);
        expect(json.required).toBeUndefined();
    });

    it('does not confuse a partial record with an exhaustive one that has a different key set', () => {
        const schema = z.object({
            exhaustive: z.record(z.enum(['a', 'b']), z.number()),
            partial: z.partialRecord(z.enum(['c', 'd']), z.number())
        });
        const json = {
            type: 'object',
            properties: { exhaustive: gapRecordJson(['a', 'b']), partial: gapRecordJson(['c', 'd']) },
            required: ['exhaustive', 'partial']
        } as Record<string, unknown>;
        addRequiredToExhaustiveRecords(schema, json);
        const properties = json.properties as Record<string, Record<string, unknown>>;
        expect(properties.exhaustive!.required).toEqual(['a', 'b']);
        expect(properties.partial!.required).toBeUndefined();
    });
});

describe('standardSchemaToJsonSchema — exhaustive record required (fallback path)', () => {
    it('emits required for enum-keyed records so the advertised schema matches validation', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const schema = withoutStandardJsonSchema(z.object({ config: z.record(z.enum(['a', 'b']), z.number()) }));
        const result = standardSchemaToJsonSchema(schema, 'input');
        const config = (result.properties as Record<string, Record<string, unknown>>).config!;
        expect(config.required).toEqual(['a', 'b']);
        warn.mockRestore();
    });

    it('emits no required for partialRecord', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const schema = withoutStandardJsonSchema(z.object({ config: z.partialRecord(z.enum(['a', 'b']), z.number()) }));
        const result = standardSchemaToJsonSchema(schema, 'input');
        const config = (result.properties as Record<string, Record<string, unknown>>).config!;
        expect(config.required).toBeUndefined();
        warn.mockRestore();
    });
});
