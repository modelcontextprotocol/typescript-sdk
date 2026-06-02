import { vi } from 'vitest';
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
    test('passes through a Standard Schema without `~standard.jsonSchema` (per-vendor handling deferred to standardSchemaToJsonSchema)', () => {
        const noJson = { '~standard': { version: 1, vendor: 'x', validate: () => ({ value: {} }) } };
        expect(normalizeRawShapeSchema(noJson as never)).toBe(noJson);
    });
    test('passes through a zod 4.0-4.1 schema so standardSchemaToJsonSchema can apply its z.toJSONSchema fallback', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const real = z.object({ a: z.string() });
        // Simulate zod 4.0-4.1: shadow `~standard` with `jsonSchema` removed, keep `_zod` intact.
        const { jsonSchema: _drop, ...stdNoJson } = real['~standard'] as unknown as Record<string, unknown>;
        void _drop;
        Object.defineProperty(real, '~standard', { value: { ...stdNoJson, vendor: 'zod' }, configurable: true });

        const normalized = normalizeRawShapeSchema(real);
        expect(normalized).toBe(real);
        const json = standardSchemaToJsonSchema(normalized!, 'input');
        expect(json.type).toBe('object');
        expect((json.properties as Record<string, unknown>)?.a).toBeDefined();
        warn.mockRestore();
    });
    test('throws actionable TypeError for a raw shape with Zod v3 fields', () => {
        expect(() => normalizeRawShapeSchema({ a: mockZodV3String() } as never)).toThrow(/Zod v4 schemas.*Got a Zod v3 field schema/);
    });
    test('throws the intended TypeError (not Object.values crash) for null input', () => {
        expect(() => normalizeRawShapeSchema(null as never)).toThrow(/must be a Standard Schema/);
    });
});

// Minimal structural stand-in for a v4-detected field schema whose internals
// the SDK-bundled `z.toJSONSchema()` cannot walk. Deterministic and
// build-independent; the real-instance equivalent (an actual second zod
// install) is covered in the real-instance tests below.
function mockForeignZodV4String(): unknown {
    return {
        _zod: { def: { type: 'string' }, version: { major: 4, minor: 0 } },
        '~standard': { version: 1, vendor: 'zod', validate: (v: unknown) => ({ value: v }) }
    };
}

describe('normalizeRawShapeSchema v1-compat dispatch', () => {
    test('throws the v1 error for a shape mixing zod versions (exact message)', () => {
        const shape = { a: z.string(), b: mockZodV3String() };
        expect(() => normalizeRawShapeSchema(shape as never)).toThrow('Mixed Zod versions detected in object shape.');
    });

    test('mixed-version error is not misreported as the all-v3 error', () => {
        const shape = { a: z.string(), b: mockZodV3String() };
        expect(() => normalizeRawShapeSchema(shape as never)).not.toThrow(/must be Zod v4 schemas/);
    });

    test('fails at normalization time when raw-shape fields cannot be converted to JSON Schema', () => {
        // Without the eager check this registers fine and `tools/list` crashes later.
        const shape = { a: mockForeignZodV4String() };
        expect(() => normalizeRawShapeSchema(shape as never)).toThrow(/could not be converted to JSON Schema/);
    });

    test('conversion failure preserves the underlying error as cause', () => {
        const shape = { a: mockForeignZodV4String() };
        try {
            normalizeRawShapeSchema(shape as never);
            expect.unreachable('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(TypeError);
            expect((e as TypeError).cause).toBeDefined();
        }
    });

    test('wraps and converts a well-formed raw shape for the output position', () => {
        const wrapped = normalizeRawShapeSchema({ result: z.string().default('x') }, 'output');
        expect(wrapped).toBeDefined();
        expect(standardSchemaToJsonSchema(wrapped!, 'output').type).toBe('object');
    });
});

// Real second zod instance (npm alias zod-v40 -> zod@4.0.17): implements
// StandardSchemaV1 but not `~standard.jsonSchema`, like most currently
// installed zod versions. The SDK-bundled converter cannot walk schemas from
// this build, so raw shapes built from it are exactly the input that used to
// register fine and then crash every `tools/list`.
import * as zV40 from 'zod-v40';

describe('normalizeRawShapeSchema real-instance coverage', () => {
    test('native z.custom raw-shape field fails at normalization time (version-independent construct)', () => {
        const shape = { c: z.custom<string>(v => typeof v === 'string') };
        expect(() => normalizeRawShapeSchema(shape as never)).toThrow(/could not be converted to JSON Schema/);
        // The thrown message itself carries the converter's diagnosis, so the
        // bundled-zod non-representable case is distinguishable from a foreign
        // zod build without unwrapping `cause`.
        expect(() => normalizeRawShapeSchema(shape as never)).toThrow(/Non-representable type|custom/i);
    });

    test('raw shape from a real foreign zod build fails at normalization time, not serve time', () => {
        const shape = { a: zV40.z.string(), o: zV40.z.string().optional() };
        try {
            normalizeRawShapeSchema(shape as never);
            expect.unreachable('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(TypeError);
            expect(String(e)).toMatch(/could not be converted to JSON Schema/);
            // the underlying converter error is preserved for debugging
            expect(String((e as TypeError).cause)).toMatch(/Non-representable type/);
        }
    });
});
