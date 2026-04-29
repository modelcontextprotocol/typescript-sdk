import * as z from 'zod/v4';

import { standardSchemaToJsonSchema } from '../../src/util/standardSchema.js';
import { isZodRawShape, normalizeRawShapeSchema } from '../../src/util/zodCompat.js';

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
    test('rejects a shape with non-Zod Standard Schema fields', () => {
        const nonZod = { '~standard': { version: 1, vendor: 'arktype', validate: () => ({ value: 'x' }) } };
        expect(isZodRawShape({ a: nonZod })).toBe(false);
    });
    test('rejects a shape with Zod v3 fields (only v4 is wrappable)', () => {
        expect(isZodRawShape({ a: mockZodV3String() })).toBe(false);
    });
    test('rejects non-plain objects with no own-enumerable properties', () => {
        expect(isZodRawShape([])).toBe(false);
        expect(isZodRawShape([z.string()])).toBe(false);
        expect(isZodRawShape(new Date())).toBe(false);
        expect(isZodRawShape(new Map())).toBe(false);
        expect(isZodRawShape(/regex/)).toBe(false);
    });
    test('accepts a null-prototype plain object', () => {
        const o = Object.create(null);
        o.a = z.string();
        expect(isZodRawShape(o)).toBe(true);
    });
});

// Minimal structural mock of a Zod v3 schema: has `_def.typeName` and
// `~standard.vendor === 'zod'` (zod >=3.24), but no `_zod`.
function mockZodV3String(): unknown {
    return {
        _def: { typeName: 'ZodString', checks: [], coerce: false },
        '~standard': { version: 1, vendor: 'zod', validate: (v: unknown) => ({ value: v }) },
        parse: (v: unknown) => v
    };
}

describe('normalizeRawShapeSchema', () => {
    test('wraps empty raw shape into z.object({})', () => {
        const wrapped = normalizeRawShapeSchema({});
        expect(wrapped).toBeDefined();
        expect(standardSchemaToJsonSchema(wrapped!, 'input').type).toBe('object');
    });
    test('passes through an already-wrapped Standard Schema unchanged', () => {
        const schema = z.object({ a: z.string() });
        expect(normalizeRawShapeSchema(schema)).toBe(schema);
    });
    test('returns undefined for undefined input', () => {
        expect(normalizeRawShapeSchema(undefined)).toBeUndefined();
    });
    test('throws TypeError for an invalid object that is neither raw shape nor Standard Schema', () => {
        expect(() => normalizeRawShapeSchema({ a: 'not a zod schema' } as never)).toThrow(TypeError);
    });
    test('throws TypeError for a Standard Schema without JSON Schema export', () => {
        const noJson = { '~standard': { version: 1, vendor: 'x', validate: () => ({ value: {} }) } };
        expect(() => normalizeRawShapeSchema(noJson as never)).toThrow(/~standard\.jsonSchema/);
    });
    test('throws actionable TypeError for a raw shape with Zod v3 fields', () => {
        expect(() => normalizeRawShapeSchema({ a: mockZodV3String() } as never)).toThrow(/Zod v4 schemas.*Got a Zod v3 field schema/);
    });
    test('throws the intended TypeError (not Object.values crash) for null input', () => {
        expect(() => normalizeRawShapeSchema(null as never)).toThrow(/must be a Standard Schema/);
    });
});
