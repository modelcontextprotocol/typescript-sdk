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
});

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
});
