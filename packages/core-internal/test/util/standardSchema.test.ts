import * as z from 'zod/v4';

import { standardSchemaToJsonSchema } from '../../src/util/standardSchema';
import { isNonObjectJsonSchemaRoot } from '../../src/wire/rev2025-11-25/legacyWrap';

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

describe('zod conversion options (#2464)', () => {
    test('z.date() converts to string/date-time instead of throwing (input)', () => {
        const result = standardSchemaToJsonSchema(z.object({ when: z.date() }), 'input');

        expect((result.properties as Record<string, unknown>).when).toEqual({ type: 'string', format: 'date-time' });
    });

    test('z.date() converts to string/date-time instead of throwing (output)', () => {
        const result = standardSchemaToJsonSchema(z.object({ when: z.date() }), 'output');

        expect((result.properties as Record<string, unknown>).when).toEqual({ type: 'string', format: 'date-time' });
    });

    test('other unrepresentable types degrade to an unconstrained schema instead of throwing', () => {
        const result = standardSchemaToJsonSchema(z.object({ big: z.bigint() }), 'input');

        expect((result.properties as Record<string, unknown>).big).toEqual({});
    });

    test('z.date() keeps user annotations alongside the rewritten wire shape', () => {
        const result = standardSchemaToJsonSchema(z.object({ when: z.date().describe('event timestamp') }), 'input');

        expect((result.properties as Record<string, unknown>).when).toEqual({
            type: 'string',
            format: 'date-time',
            description: 'event timestamp'
        });
    });

    test("unrepresentable: 'throw' restores zod's conversion error (elicitation contract)", () => {
        expect(() => standardSchemaToJsonSchema(z.object({ when: z.date() }), 'input', { unrepresentable: 'throw' })).toThrow(
            /Date cannot be represented/
        );
    });

    test('defaulted fields are not advertised as required in output schemas', () => {
        const schema = z.object({ counted: z.number().default(0), name: z.string() });
        const result = standardSchemaToJsonSchema(schema, 'output');

        // The server ships the tool's raw structuredContent without filling defaults,
        // so a payload omitting `counted` must satisfy the advertised schema.
        expect(result.required).toEqual(['name']);
    });

    test('a registered .default() (emitted as $ref) is still dropped from output required', () => {
        const schema = z.object({ counted: z.number().default(0).meta({ id: 'StandardSchemaTestCounted' }), name: z.string() });
        const result = standardSchemaToJsonSchema(schema, 'output');

        // The `default` keyword hides inside $defs behind a bare $ref; the filter must
        // key on the zod shape, not the emitted JSON.
        expect((result.properties as Record<string, Record<string, unknown>>).counted?.$ref).toBeDefined();
        expect(result.required).toEqual(['name']);
    });

    test('a required field annotated with .meta({default}) stays required in output schemas', () => {
        const schema = z.object({ label: z.string().meta({ default: 'n/a' }), other: z.number() });
        const result = standardSchemaToJsonSchema(schema, 'output');

        // The annotation carries a `default` keyword, but validation still requires the
        // field, so every shipped payload carries it.
        expect(result.required).toEqual(['label', 'other']);
    });

    test('undefined-accepting fields are not advertised as required in output schemas', () => {
        const schema = z.object({ a: z.any(), u: z.unknown(), v: z.undefined(), name: z.string() });
        const result = standardSchemaToJsonSchema(schema, 'output');

        // A raw payload with an undefined-valued key passes validation, and
        // JSON.stringify drops the key from the wire entirely.
        expect(result.required).toEqual(['name']);
    });

    test('enum-keyed records with a defaulted value drop the emitted required list (output)', () => {
        const schema = z.object({ tallies: z.record(z.enum(['likes', 'shares']), z.number().default(0)), name: z.string() });
        const result = standardSchemaToJsonSchema(schema, 'output');

        // zod fills record defaults during validation, so `{}` is a legitimate raw value
        // for the record node — but the record field itself stays required on the parent.
        const tallies = (result.properties as Record<string, Record<string, unknown>>).tallies!;
        expect(tallies.required).toBeUndefined();
        expect(result.required).toEqual(['tallies', 'name']);
    });

    test('enum-keyed records with a strict value keep the emitted required list (output)', () => {
        const schema = z.record(z.enum(['likes', 'shares']), z.number());
        const result = standardSchemaToJsonSchema(schema, 'output');

        // Validation rejects a missing key here, so the required list is truthful.
        expect(result.required).toEqual(['likes', 'shares']);
    });

    test('a defaulted field with an async stage is still dropped from output required', () => {
        const schema = z.object({
            d: z
                .number()
                .default(0)
                .refine(async () => true),
            name: z.string()
        });
        const result = standardSchemaToJsonSchema(schema, 'output');

        // The async refine pushes the validate(undefined) probe to a Promise, but a
        // defaulted field accepts a missing key by construction — decided structurally.
        expect(result.required).toEqual(['name']);
    });

    test('.catch() output nodes degrade to an unconstrained schema (annotations kept)', () => {
        const schema = z.object({
            inner: z.object({ n: z.string() }).catch({ n: 'd' }).describe('lenient'),
            scalar: z.number().catch(0),
            annotated: z.number().catch(0).meta({ 'x-ui': 1, title: 't' }),
            name: z.string()
        });
        const result = standardSchemaToJsonSchema(schema, 'output');

        // Catch-validation accepts any raw value (the fallback replaces it only in the
        // parsed result, which never ships), so no inner constraint may be advertised.
        // The emitted `type` is kept: the verdict must be position-independent (zod
        // deduplicates reused instances), and root positions need it for the 2025-era
        // legacy-wrap object proof.
        const properties = result.properties as Record<string, Record<string, unknown>>;
        expect(properties.inner).toEqual({ description: 'lenient', default: { n: 'd' }, type: 'object' });
        expect(properties.scalar).toEqual({ default: 0, type: 'number' });
        // `x-*` vendor extensions are annotation-only and must survive the degrade.
        expect(properties.annotated).toEqual({ default: 0, title: 't', 'x-ui': 1, type: 'number' });
        // A raw payload omitting the catch fields also validates, so they are not required.
        expect(result.required).toEqual(['name']);
    });

    test('a .catch() instance reused at nested and root-proof positions is safe in both orderings', () => {
        // zod deduplicates reused instances and runs the override once per instance,
        // so the degrade verdict is shared by every occurrence — it must not depend
        // on which position is seen first.
        for (const makeUnion of [
            (c: z.ZodType) => z.union([z.object({ x: c }), c]), // nested seen first
            (c: z.ZodType) => z.union([c, z.object({ x: c })]) // root member seen first
        ]) {
            const shared = z.object({ q: z.string() }).catch({ q: 'd' });
            const result = standardSchemaToJsonSchema(makeUnion(shared), 'output');

            // The root object proof must hold (no 2025-era legacy-wrap flip) ...
            expect(result.type).toBe('object');
            expect(isNonObjectJsonSchemaRoot(result)).toBe(false);
            const members = result.anyOf as Array<Record<string, unknown>>;
            const nested = members.find(m => m.properties !== undefined)!;
            const rootMember = members.find(m => m.properties === undefined)!;
            // ... and no occurrence may advertise the unenforced inner constraints.
            expect((nested.properties as Record<string, Record<string, unknown>>).x).toEqual({ default: { q: 'd' }, type: 'object' });
            expect(rootMember).toEqual({ default: { q: 'd' }, type: 'object' });
        }
    });

    test('a root-position .catch() output schema keeps its emitted object root', () => {
        const result = standardSchemaToJsonSchema(z.object({ n: z.string() }).catch({ n: 'd' }), 'output');

        // Degrading the ROOT would delete `type: 'object'` and flip the 2025-era
        // codec's legacy-wrap predicate — a silent wire change for such tools.
        expect(result.type).toBe('object');
        expect(isNonObjectJsonSchemaRoot(result)).toBe(false);
    });

    test('a .catch() member of a root union keeps its emitted shape (root still proves object)', () => {
        const schema = z.union([z.object({ a: z.string() }), z.object({ b: z.string() }).catch({ b: 'd' })]);
        const result = standardSchemaToJsonSchema(schema, 'output');

        // Degrading the member would break `isProvablyObjectShapedRoot`'s every-member
        // proof, leave the root typeless, and flip the 2025-era legacy wrap — a silent
        // wire change for a previously-working registration.
        expect(result.type).toBe('object');
        expect(isNonObjectJsonSchemaRoot(result)).toBe(false);
        expect((result.anyOf as Array<Record<string, unknown>>)[1]?.type).toBe('object');
    });

    test('unrepresentable non-object roots still throw on the input path', () => {
        // `unrepresentable: 'any'` degrades these roots to a typeless {}, which must not
        // be stamped `type: 'object'` — the tool would be advertised but never callable.
        expect(() => standardSchemaToJsonSchema(z.bigint(), 'input')).toThrow(/must describe objects/);
        expect(() => standardSchemaToJsonSchema(z.map(z.string(), z.number()), 'input')).toThrow(/must describe objects/);
        expect(() => standardSchemaToJsonSchema(z.set(z.string()), 'input')).toThrow(/must describe objects/);
        expect(() => standardSchemaToJsonSchema(z.symbol(), 'input')).toThrow(/must describe objects/);
        expect(() => standardSchemaToJsonSchema(z.void(), 'input')).toThrow(/must describe objects/);
        expect(() => standardSchemaToJsonSchema(z.undefined(), 'input')).toThrow(/must describe objects/);
        expect(() => standardSchemaToJsonSchema(z.nan(), 'input')).toThrow(/must describe objects/);
        expect(() => standardSchemaToJsonSchema(z.function(), 'input')).toThrow(/must describe objects/);
        // Wrappers and lazies must not hide a non-object root from the guard.
        expect(() => standardSchemaToJsonSchema(z.bigint().optional(), 'input')).toThrow(/must describe objects/);
        expect(() => standardSchemaToJsonSchema(z.bigint().nullable(), 'input')).toThrow(/must describe objects/);
        expect(() => standardSchemaToJsonSchema(z.bigint().readonly(), 'input')).toThrow(/must describe objects/);
        expect(() =>
            standardSchemaToJsonSchema(
                z.lazy(() => z.bigint()),
                'input'
            )
        ).toThrow(/must describe objects/);
        // Typeless literal roots (unrepresentable or mixed-type values) are not objects.
        expect(() => standardSchemaToJsonSchema(z.literal(undefined), 'input')).toThrow(/must describe objects/);
        expect(() => standardSchemaToJsonSchema(z.literal(['a', 1]), 'input')).toThrow(/must describe objects/);
        // Pipes unwrap via their INPUT side, and promises via their inner type.
        expect(() =>
            standardSchemaToJsonSchema(
                z.bigint().transform(x => Number(x)),
                'input'
            )
        ).toThrow(/must describe objects/);
        expect(() => standardSchemaToJsonSchema(z.bigint().pipe(z.transform((x: bigint) => Number(x))), 'input')).toThrow(
            /must describe objects/
        );
        expect(() => standardSchemaToJsonSchema(z.promise(z.bigint()), 'input')).toThrow(/must describe objects/);
        // `.nonoptional()` is a transparent wrapper like its siblings.
        expect(() => standardSchemaToJsonSchema(z.bigint().nonoptional(), 'input')).toThrow(/must describe objects/);
        // Compositions: a union is non-object when EVERY member is, an intersection
        // when ANY side is.
        expect(() => standardSchemaToJsonSchema(z.union([z.bigint(), z.symbol()]), 'input')).toThrow(/must describe objects/);
        expect(() => standardSchemaToJsonSchema(z.intersection(z.bigint(), z.bigint()), 'input')).toThrow(/must describe objects/);
        // Wrapped OBJECT roots stay accepted.
        expect(standardSchemaToJsonSchema(z.object({ a: z.string() }).optional(), 'input').type).toBe('object');
        expect(
            standardSchemaToJsonSchema(
                z.object({ a: z.string() }).transform(o => o),
                'input'
            ).type
        ).toBe('object');
        // A union with one representable object member stays accepted.
        expect(standardSchemaToJsonSchema(z.union([z.bigint(), z.object({ a: z.string() })]), 'input').type).toBe('object');
    });

    test('symbol- and function-valued output fields are not advertised as required', () => {
        const schema = z.object({ s: z.symbol(), f: z.function(), name: z.string() });
        const result = standardSchemaToJsonSchema(schema, 'output');

        // JSON.stringify drops Symbol- and function-valued keys from the payload, so
        // no serialized result can ever carry them.
        expect(result.required).toEqual(['name']);
    });

    test('a .catch() wrapping a union keeps a composition type skeleton (root still proves object)', () => {
        const schema = z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]).catch({ a: 'd' });
        const result = standardSchemaToJsonSchema(schema, 'output');

        // The catch node emits {anyOf, default} with no `type`; deleting `anyOf`
        // would leave the root typeless and flip the 2025-era legacy wrap.
        expect(result.anyOf).toEqual([{ type: 'object' }, { type: 'object' }]);
        expect(result.type).toBe('object');
        expect(isNonObjectJsonSchemaRoot(result)).toBe(false);
    });

    test('a required field whose transform throws on undefined stays required and does not crash', async () => {
        const schema = z.object({ n: z.unknown().transform(v => (v as string).length), name: z.string() });
        const result = standardSchemaToJsonSchema(schema, 'output');

        // The missing-key probe cannot demonstrate tolerance (the transform throws on
        // undefined; depending on the zod version the probe throws synchronously or
        // returns a rejecting Promise) — the field conservatively stays required, and
        // no unhandled rejection may escape (vitest fails the run on one).
        expect(result.required).toEqual(['n', 'name']);
        await new Promise(resolve => setTimeout(resolve, 10));
    });

    test('plain z.object() output schemas do not advertise additionalProperties:false', () => {
        const result = standardSchemaToJsonSchema(z.object({ name: z.string() }), 'output');

        // zod validation passes unknown keys through on plain objects, so the raw
        // payload may carry extras the advertised schema must not forbid.
        expect(result.additionalProperties).toBeUndefined();
    });

    test('z.strictObject() output schemas keep additionalProperties:false', () => {
        const result = standardSchemaToJsonSchema(z.strictObject({ name: z.string() }), 'output');

        // Strict objects reject extras during validation, so the promise is kept.
        expect(result.additionalProperties).toBe(false);
    });
});
