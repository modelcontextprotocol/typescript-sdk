import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';
import { standardSchemaToJsonSchema } from '../../src/util/standardSchema.js';

type SchemaArg = Parameters<typeof standardSchemaToJsonSchema>[0];

describe('standardSchemaToJsonSchema — zod fallback paths', () => {
    it('falls back to z.toJSONSchema for zod 4.0–4.1 (vendor=zod, no ~standard.jsonSchema, has _zod)', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const real = z.object({ a: z.string() });
        // Simulate zod 4.0–4.1: shadow `~standard` on the real instance with `jsonSchema` removed.
        // Keeps the rest of the zod 4 object (including `_zod`) intact so z.toJSONSchema can introspect it.
        const { jsonSchema: _drop, ...stdNoJson } = real['~standard'] as unknown as Record<string, unknown>;
        void _drop;
        Object.defineProperty(real, '~standard', { value: { ...stdNoJson, vendor: 'zod' }, configurable: true });

        const result = standardSchemaToJsonSchema(real as unknown as SchemaArg);
        expect(result.type).toBe('object');
        expect((result.properties as unknown as Record<string, unknown>)?.a).toBeDefined();
        expect(warn).toHaveBeenCalledOnce();
        expect(warn.mock.calls[0]?.[0]).toContain('zod 4.2.0');
        warn.mockRestore();
    });

    it('throws a clear error for zod 3 (vendor=zod, no ~standard.jsonSchema, no _zod)', () => {
        // zod 3.24+ reports `~standard.vendor === 'zod'` but has no `_zod` internal marker.
        const zod3ish = { _def: {}, '~standard': { version: 1, vendor: 'zod', validate: () => ({ value: {} }) } };
        expect(() => standardSchemaToJsonSchema(zod3ish as unknown as SchemaArg)).toThrow(/zod 3/);
        expect(() => standardSchemaToJsonSchema(zod3ish as unknown as SchemaArg)).toThrow(/4\.2\.0/);
    });

    it('throws a clear error for non-zod libraries without ~standard.jsonSchema', () => {
        const fake = { '~standard': { version: 1, vendor: 'mylib', validate: () => ({ value: {} }) } };
        expect(() => standardSchemaToJsonSchema(fake as unknown as SchemaArg)).toThrow(/mylib/);
        expect(() => standardSchemaToJsonSchema(fake as unknown as SchemaArg)).toThrow(/fromJsonSchema/);
    });
});
