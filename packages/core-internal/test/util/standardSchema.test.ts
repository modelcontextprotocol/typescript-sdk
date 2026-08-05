import * as z from 'zod/v4';

import { standardSchemaToJsonSchema } from '../../src/util/standardSchema';
import { AjvJsonSchemaValidator } from '../../src/validators/ajvProvider';
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

    test('a defaulted field piped through a transform is still dropped from output required', () => {
        const schema = z.object({
            asyncPiped: z
                .number()
                .default(7)
                .transform(async v => v),
            syncPiped: z
                .number()
                .default(7)
                .transform(v => v),
            name: z.string()
        });
        const result = standardSchemaToJsonSchema(schema, 'output');

        // `.default(7).transform(...)` is outer-'pipe' with the ZodDefault at def.in;
        // the structural check must unwind the pipe's input side, since the async
        // stage pushes the validate(undefined) probe to a Promise.
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
        // parsed result, which never ships), so no inner constraint may be advertised —
        // including a non-object `type`, which would reject the wrong-typed raw values
        // catch exists to tolerate. Only `type: 'object'` is kept: the verdict must be
        // position-independent (zod deduplicates reused instances), and it is all the
        // 2025-era legacy-wrap object proof consumes.
        const properties = result.properties as Record<string, Record<string, unknown>>;
        expect(properties.inner).toEqual({ description: 'lenient', default: { n: 'd' }, type: 'object' });
        expect(properties.scalar).toEqual({ default: 0 });
        // `x-*` vendor extensions are annotation-only and must survive the degrade.
        expect(properties.annotated).toEqual({ default: 0, title: 't', 'x-ui': 1 });
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
        // Literals with genuinely unrepresentable values are not objects.
        expect(() => standardSchemaToJsonSchema(z.literal(undefined), 'input')).toThrow(/must describe objects/);
        // Mixed-but-REPRESENTABLE literals emit a valid {enum: [...]}: they listed
        // silently pre-#2464 (an uncallable phantom, but harmless to other tools)
        // and must keep doing so — throwing here would fail the whole tools/list.
        expect(standardSchemaToJsonSchema(z.literal(['a', 1]), 'input').type).toBe('object');
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

    test('shared-instance union members each get a real verdict', () => {
        // The cycle guard tracks only the current traversal path, so a schema constant
        // reused across union arms must not short-circuit the second member's verdict.
        const shared = z.bigint();
        expect(() => standardSchemaToJsonSchema(z.union([shared, shared]), 'input')).toThrow(/must describe objects/);
    });

    test('representable literal unions keep listing (idiomatic zod enum spelling)', () => {
        // Regression: these converted and listed pre-#2464 — classifying every literal
        // member as non-object made one such registration fail the ENTIRE tools/list.
        expect(standardSchemaToJsonSchema(z.union([z.literal('admin'), z.literal('member')]), 'input').type).toBe('object');
        expect(standardSchemaToJsonSchema(z.intersection(z.object({ a: z.string() }), z.literal('a')), 'input').type).toBe('object');
        // Representable non-object members also keep the composition accepted, exactly
        // as such roots converted pre-#2464.
        expect(standardSchemaToJsonSchema(z.union([z.string(), z.number()]), 'input').type).toBe('object');
        expect(standardSchemaToJsonSchema(z.union([z.literal('a'), z.null()]), 'input').type).toBe('object');
        // Literals with unrepresentable values still reject inside compositions.
        expect(() => standardSchemaToJsonSchema(z.union([z.literal(undefined), z.bigint()]), 'input')).toThrow(/must describe objects/);
    });

    test('date members and non-finite literals classify as non-object inside compositions', () => {
        // A Date value can never be a JSON object; at member position the rewritten
        // string/date-time node nests inside anyOf and evades the explicit-type guard.
        expect(() => standardSchemaToJsonSchema(z.union([z.date(), z.date()]), 'input')).toThrow(/must describe objects/);
        expect(() => standardSchemaToJsonSchema(z.union([z.date(), z.bigint()]), 'input')).toThrow(/must describe objects/);
        expect(() => standardSchemaToJsonSchema(z.intersection(z.object({ a: z.string() }), z.date()), 'input')).toThrow(
            /must describe objects/
        );
        // Infinity/-Infinity/NaN literals are typeof 'number' but cannot ride JSON.
        expect(() => standardSchemaToJsonSchema(z.union([z.literal(Infinity), z.bigint()]), 'input')).toThrow(/must describe objects/);
        expect(() => standardSchemaToJsonSchema(z.union([z.literal(Number.NaN), z.bigint()]), 'input')).toThrow(/must describe objects/);
        // A representable member keeps the composition accepted (every-member rule).
        expect(standardSchemaToJsonSchema(z.union([z.date(), z.string()]), 'input').type).toBe('object');
    });

    test('preprocess-wrapped unrepresentable roots throw (transform at def.in, schema at def.out)', () => {
        // z.preprocess builds the opposite pipe; the guard must look past the
        // transform at def.in to the real schema at def.out.
        expect(() =>
            standardSchemaToJsonSchema(
                z.preprocess(v => v, z.bigint()),
                'input'
            )
        ).toThrow(/must describe objects/);
        expect(() => standardSchemaToJsonSchema(z.union([z.preprocess(v => v, z.bigint()), z.symbol()]), 'input')).toThrow(
            /must describe objects/
        );
        // Object-rooted preprocess stays accepted; date still throws via the
        // explicit-type guard after the rewrite.
        expect(
            standardSchemaToJsonSchema(
                z.preprocess(v => v, z.object({ a: z.string() })),
                'input'
            ).type
        ).toBe('object');
        expect(() =>
            standardSchemaToJsonSchema(
                z.preprocess(v => v, z.date()),
                'input'
            )
        ).toThrow(/must describe objects/);
    });

    test('compositions built solely of non-finite literals keep listing (quiet verdicts)', () => {
        // These converted silently pre-#2464 (zod emits {type: 'number', const: null}
        // without throwing) — throwing here would fail the whole tools/list. The
        // guard throws only when the composition also carries a LOUD member (one
        // that made pre-#2464 conversion throw, e.g. a bigint).
        expect(standardSchemaToJsonSchema(z.union([z.literal(Infinity), z.literal(-Infinity)]), 'input').type).toBe('object');
        expect(standardSchemaToJsonSchema(z.union([z.literal(Infinity), z.literal(Number.NaN)]), 'input').type).toBe('object');
        expect(standardSchemaToJsonSchema(z.intersection(z.object({ a: z.string() }), z.literal(Infinity)), 'input').type).toBe('object');
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

    test('a .catch() wrapping a discriminated union skeletonizes oneOf as anyOf', () => {
        const du = z
            .discriminatedUnion('t', [z.object({ t: z.literal('a'), x: z.string() }), z.object({ t: z.literal('b'), y: z.string() })])
            .catch({ t: 'a', x: 'd' });

        // With member constraints stripped, `oneOf` skeletons are indistinguishable —
        // every payload would match BOTH members and Ajv rejects "must match exactly
        // one schema in oneOf". The honest loosening is `anyOf` (wrap-neutral).
        const root = standardSchemaToJsonSchema(du, 'output');
        expect(root.oneOf).toBeUndefined();
        expect(root.anyOf).toEqual([{ type: 'object' }, { type: 'object' }]);
        expect(root.type).toBe('object');
        expect(isNonObjectJsonSchemaRoot(root)).toBe(false);
        const rootValidate = new AjvJsonSchemaValidator().getValidator(root);
        expect(rootValidate({ t: 'a', x: 'hello' }).valid).toBe(true);

        const nested = standardSchemaToJsonSchema(z.object({ res: du, name: z.string() }), 'output');
        const res = (nested.properties as Record<string, Record<string, unknown>>).res!;
        expect(res.oneOf).toBeUndefined();
        expect(res.anyOf).toEqual([{ type: 'object' }, { type: 'object' }]);
        const nestedValidate = new AjvJsonSchemaValidator().getValidator(nested);
        expect(nestedValidate({ res: { t: 'a', x: 'hello' }, name: 'n' }).valid).toBe(true);
    });

    test('a discriminated union with catch-wrapped discriminators loosens its oneOf to anyOf', () => {
        // The catch degrade strips each discriminator's type/const and the
        // required-filter drops 't', so the members become mutually satisfiable —
        // the untouched parent's `oneOf` would then reject EVERY payload ("must
        // match exactly one schema in oneOf").
        const du = z.discriminatedUnion('t', [
            z.object({ t: z.literal('a').catch('a'), x: z.string().optional() }),
            z.object({ t: z.literal('b').catch('b'), y: z.string().optional() })
        ]);

        const root = standardSchemaToJsonSchema(du, 'output');
        expect(root.oneOf).toBeUndefined();
        expect(Array.isArray(root.anyOf)).toBe(true);
        expect(new AjvJsonSchemaValidator().getValidator(root)({ t: 'a', x: 'v' }).valid).toBe(true);

        const nested = standardSchemaToJsonSchema(z.object({ res: du, name: z.string() }), 'output');
        const res = (nested.properties as Record<string, Record<string, unknown>>).res!;
        expect(res.oneOf).toBeUndefined();
        expect(new AjvJsonSchemaValidator().getValidator(nested)({ res: { t: 'a', x: 'v' }, name: 'n' }).valid).toBe(true);
    });

    test('a discriminated union without degraded nodes keeps its oneOf', () => {
        // Untouched schemas must not be loosened: exactly-one semantics stay
        // truthful while the members keep their discriminating constraints.
        const du = z.discriminatedUnion('t', [
            z.object({ t: z.literal('a'), x: z.string() }),
            z.object({ t: z.literal('b'), y: z.string() })
        ]);
        const result = standardSchemaToJsonSchema(du, 'output');

        expect(Array.isArray(result.oneOf)).toBe(true);
        expect(result.anyOf).toBeUndefined();
        expect(new AjvJsonSchemaValidator().getValidator(result)({ t: 'a', x: 'v' }).valid).toBe(true);
    });

    test('tolerant array/tuple elements also accept null in output schemas', () => {
        // JSON.stringify turns an undefined array ELEMENT into null (it drops
        // undefined-valued object keys), so the raw payload the server validates and
        // ships ([1, undefined, 3]) reaches the wire as [1, null, 3].
        const schema = z.object({
            a: z.array(z.number().default(0)),
            t: z.tuple([z.string().default('x'), z.number()]),
            name: z.string()
        });
        const result = standardSchemaToJsonSchema(schema, 'output');

        expect(new AjvJsonSchemaValidator().getValidator(result)({ a: [1, null, 3], t: [null, 1], name: 'n' }).valid).toBe(true);
        // Non-tolerant elements keep their strict subschema.
        const plain = standardSchemaToJsonSchema(z.object({ a: z.array(z.number()) }), 'output');
        expect((plain.properties as Record<string, Record<string, unknown>>).a!.items).toEqual({ type: 'number' });
    });

    test('z.never() union members are quiet non-object verdicts', () => {
        // z.never() matches no value: it cannot make a union satisfiable, so a loud
        // co-member must keep the pre-#2464 throw ...
        expect(() => standardSchemaToJsonSchema(z.union([z.never(), z.bigint()]), 'input')).toThrow(/must describe objects/);
        // ... while quiet shapes (which converted silently pre-#2464) keep listing.
        expect(standardSchemaToJsonSchema(z.never(), 'input').type).toBe('object');
        expect(standardSchemaToJsonSchema(z.union([z.never(), z.string()]), 'input').type).toBe('object');
        expect(standardSchemaToJsonSchema(z.union([z.never(), z.never()]), 'input').type).toBe('object');
    });

    test('unrepresentable non-object OUTPUT roots throw too (loudness parity)', () => {
        // These threw at tools/list pre-#2464; post-degrade they would list silently
        // as permanently-broken tools (bigint results even fail JSON-RPC
        // serialization; Map/Set ship {} garbage).
        expect(() => standardSchemaToJsonSchema(z.bigint(), 'output')).toThrow(/must describe objects/);
        expect(() => standardSchemaToJsonSchema(z.union([z.bigint(), z.symbol()]), 'output')).toThrow(/must describe objects/);
        // Representable non-object output roots are legal per SEP-2106 ...
        expect(standardSchemaToJsonSchema(z.string(), 'output').type).toBe('string');
        expect(standardSchemaToJsonSchema(z.array(z.number()), 'output').type).toBe('array');
        // ... and quiet typeless shapes keep listing.
        expect(standardSchemaToJsonSchema(z.never(), 'output').type).toBeUndefined();
    });

    test('z.file() union members are quiet non-object verdicts', () => {
        // A File can never ride JSON, so a loud co-member restores the pre-#2464 throw ...
        expect(() => standardSchemaToJsonSchema(z.union([z.file(), z.bigint()]), 'input')).toThrow(/must describe objects/);
        // ... while quiet pre-#2464 shapes keep listing (or throwing via the
        // explicit-type guard, for the bare string/binary emission).
        expect(standardSchemaToJsonSchema(z.union([z.file(), z.string()]), 'input').type).toBe('object');
        expect(standardSchemaToJsonSchema(z.intersection(z.object({ a: z.string() }), z.file()), 'input').type).toBe('object');
        expect(() => standardSchemaToJsonSchema(z.file(), 'input')).toThrow(/got type/);
    });

    test('the oneOf rewrite reaches schemas under keyword-named properties', () => {
        // Keys inside `properties` are user names, not keywords — a property
        // literally named `description` still carries a schema that the loosen
        // rewrite must reach.
        const schema = z.object({
            description: z.discriminatedUnion('t', [
                z.object({ t: z.literal('a').catch('a'), x: z.string().optional() }),
                z.object({ t: z.literal('b').catch('b'), y: z.string().optional() })
            ]),
            name: z.string()
        });
        const result = standardSchemaToJsonSchema(schema, 'output');

        const description = (result.properties as Record<string, Record<string, unknown>>).description!;
        expect(description.oneOf).toBeUndefined();
        expect(Array.isArray(description.anyOf)).toBe(true);
        expect(new AjvJsonSchemaValidator().getValidator(result)({ description: { t: 'a', x: 'v' }, name: 'n' }).valid).toBe(true);
    });

    test('tolerant tuple REST elements and non-finite literals accept their wire forms', () => {
        const schema = z.object({
            t: z.tuple([z.string()], z.number().default(0)),
            inf: z.literal(Infinity),
            name: z.string()
        });
        const result = standardSchemaToJsonSchema(schema, 'output');

        // A tuple rest element lands under `items`; an undefined rest element ships
        // as null. Non-finite literal values also serialize to null, and zod's own
        // emission ({type: 'number', const: null}) satisfies nothing.
        expect(new AjvJsonSchemaValidator().getValidator(result)({ t: ['a', 1, null], inf: null, name: 'n' }).valid).toBe(true);
    });

    test('the oneOf rewrite does not descend into annotation values', () => {
        const schema = z.object({
            cfg: z.object({ oneOf: z.array(z.number()) }).default({ oneOf: [1, 2] }),
            counted: z.number().default(0), // trips the loosened flag
            name: z.string()
        });
        const result = standardSchemaToJsonSchema(schema, 'output');

        // `default` carries user DATA — its literal `oneOf` key must survive.
        const cfg = (result.properties as Record<string, Record<string, unknown>>).cfg!;
        expect(cfg.default).toEqual({ oneOf: [1, 2] });
    });

    test('.catch() and union-nested defaults with async stages are dropped from output required', () => {
        const schema = z.object({
            c: z
                .number()
                .catch(0)
                .refine(async () => true),
            u: z.union([
                z
                    .number()
                    .default(7)
                    .transform(async v => v),
                z.string()
            ]),
            name: z.string()
        });
        const result = standardSchemaToJsonSchema(schema, 'output');

        // A static .catch() tolerates a missing key by construction (like a default),
        // and a union accepts one whenever ANY member does — both must be recognized
        // structurally, since the async stages push the validate probe to a Promise.
        expect(result.required).toEqual(['name']);
    });

    test('union-wrapped symbols, async any/unknown, and preprocess defaults are dropped from output required', () => {
        const schema = z.object({
            s: z.union([z.symbol(), z.string()]),
            a: z.any().refine(async () => true),
            u: z.unknown().transform(async v => v),
            p: z.preprocess(v => v, z.number().default(7)).refine(async () => true),
            name: z.string()
        });
        const result = standardSchemaToJsonSchema(schema, 'output');

        // JSON.stringify drops Symbol-valued keys whichever union member matched;
        // any/unknown accept undefined outright; and z.preprocess builds the
        // opposite pipe (transform at def.in, the default at def.out).
        expect(result.required).toEqual(['name']);

        // Same predicate at the record call site.
        const record = standardSchemaToJsonSchema(z.record(z.enum(['a', 'b']), z.union([z.symbol(), z.string()])), 'output');
        expect(record.required).toBeUndefined();
    });

    test('optional-in-pipe, void, undefined-literals, and both-tolerant intersections drop from output required', () => {
        const schema = z.object({
            opt: z
                .string()
                .optional()
                .transform(async v => v ?? 'x'),
            w: z.void().refine(async () => true),
            l: z.literal(undefined).refine(async () => true),
            m: z
                .intersection(z.object({ a: z.string() }).default({ a: 'x' }), z.object({ b: z.string() }).default({ b: 'y' }))
                .refine(async () => true),
            name: z.string()
        });
        const result = standardSchemaToJsonSchema(schema, 'output');

        // `optional` grants tolerance itself and must be recognized before the
        // wrapper unwind steps past it; void/undefined-literals accept a missing key
        // outright; an intersection tolerates one when BOTH sides do (each default
        // fills and zod merges the results). Async stages defeat the probe, so all
        // must be decided structurally.
        expect(result.required).toEqual(['name']);

        // Same predicate at the record call site.
        const record = standardSchemaToJsonSchema(
            z.record(
                z.enum(['a', 'b']),
                z
                    .string()
                    .optional()
                    .transform(async v => v ?? 'x')
            ),
            'output'
        );
        expect(record.required).toBeUndefined();
    });

    test('a required field whose transform throws on undefined stays required and does not crash', async () => {
        const schema = z.object({
            n: z.unknown().transform(v => (v as string).length),
            c: z.custom<string>(() => true).transform(v => (v as string).length),
            name: z.string()
        });
        const result = standardSchemaToJsonSchema(schema, 'output');

        // `n` unwinds to the undefined-accepting `z.unknown()` leaf, so it counts as
        // missing-key tolerant structurally (loosen-only). `c` unwinds to `custom`
        // (no structural verdict), so the probe runs: the transform throws on
        // undefined (depending on the zod version the probe throws synchronously or
        // returns a rejecting Promise) — the field conservatively stays required, and
        // no unhandled rejection may escape (vitest fails the run on one).
        expect(result.required).toEqual(['c', 'name']);
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
