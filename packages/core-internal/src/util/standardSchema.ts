/**
 * Standard Schema utilities for user-provided schemas.
 * Supports Zod v4, Valibot, ArkType, and other Standard Schema implementations.
 * @see https://standardschema.dev
 */

/* eslint-disable @typescript-eslint/no-namespace */

import * as z from 'zod/v4';

import type { StringSchema } from '../types/types';

// Standard Schema interfaces — vendored from https://standardschema.dev (spec v1, Jan 2025)

export interface StandardTypedV1<Input = unknown, Output = Input> {
    readonly '~standard': StandardTypedV1.Props<Input, Output>;
}

export namespace StandardTypedV1 {
    export interface Props<Input = unknown, Output = Input> {
        readonly version: 1;
        readonly vendor: string;
        readonly types?: Types<Input, Output> | undefined;
    }

    export interface Types<Input = unknown, Output = Input> {
        readonly input: Input;
        readonly output: Output;
    }

    export type InferInput<Schema extends StandardTypedV1> = NonNullable<Schema['~standard']['types']>['input'];
    export type InferOutput<Schema extends StandardTypedV1> = NonNullable<Schema['~standard']['types']>['output'];
}

export interface StandardSchemaV1<Input = unknown, Output = Input> {
    readonly '~standard': StandardSchemaV1.Props<Input, Output>;
}

export namespace StandardSchemaV1 {
    export interface Props<Input = unknown, Output = Input> extends StandardTypedV1.Props<Input, Output> {
        readonly validate: (value: unknown, options?: Options | undefined) => Result<Output> | Promise<Result<Output>>;
    }

    export interface Options {
        readonly libraryOptions?: Record<string, unknown> | undefined;
    }

    export type Result<Output> = SuccessResult<Output> | FailureResult;

    export interface SuccessResult<Output> {
        readonly value: Output;
        readonly issues?: undefined;
    }

    export interface FailureResult {
        readonly issues: ReadonlyArray<Issue>;
    }

    export interface Issue {
        readonly message: string;
        readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
    }

    export interface PathSegment {
        readonly key: PropertyKey;
    }

    export type InferInput<Schema extends StandardTypedV1> = StandardTypedV1.InferInput<Schema>;
    export type InferOutput<Schema extends StandardTypedV1> = StandardTypedV1.InferOutput<Schema>;
}

export interface StandardJSONSchemaV1<Input = unknown, Output = Input> {
    readonly '~standard': StandardJSONSchemaV1.Props<Input, Output>;
}

export namespace StandardJSONSchemaV1 {
    export interface Props<Input = unknown, Output = Input> extends StandardTypedV1.Props<Input, Output> {
        readonly jsonSchema: Converter;
    }

    export interface Converter {
        readonly input: (options: Options) => Record<string, unknown>;
        readonly output: (options: Options) => Record<string, unknown>;
    }

    export type Target = 'draft-2020-12' | 'draft-07' | 'openapi-3.0' | (object & string);

    export interface Options {
        readonly target: Target;
        readonly libraryOptions?: Record<string, unknown> | undefined;
    }

    export type InferInput<Schema extends StandardTypedV1> = StandardTypedV1.InferInput<Schema>;
    export type InferOutput<Schema extends StandardTypedV1> = StandardTypedV1.InferOutput<Schema>;
}

/**
 * Combined interface for schemas with both validation and JSON Schema conversion —
 * the intersection of {@linkcode StandardSchemaV1} and {@linkcode StandardJSONSchemaV1}.
 *
 * This is the type accepted by `registerTool` / `registerPrompt`. The SDK needs
 * `~standard.jsonSchema` to advertise the tool's argument shape in `tools/list`, and
 * `~standard.validate` to check incoming arguments when a `tools/call` arrives.
 *
 * Zod v4, ArkType, and Valibot (via `@valibot/to-json-schema`'s `toStandardJsonSchema`)
 * all implement both interfaces.
 *
 * @see https://standardschema.dev/ for the Standard Schema specification
 */
export interface StandardSchemaWithJSON<Input = unknown, Output = Input> {
    readonly '~standard': StandardSchemaV1.Props<Input, Output> & StandardJSONSchemaV1.Props<Input, Output>;
}

export namespace StandardSchemaWithJSON {
    export type InferInput<Schema extends StandardTypedV1> = StandardTypedV1.InferInput<Schema>;
    export type InferOutput<Schema extends StandardTypedV1> = StandardTypedV1.InferOutput<Schema>;
}

/**
 * Narrowing of {@linkcode StandardSchemaV1} whose `validate` is guaranteed synchronous.
 *
 * The Zod schemas backing `specTypeSchemas` contain no async refinements or transforms,
 * so every entry satisfies this interface. Consumers can call `validate()` and access
 * `.issues` / `.value` on the result without `await`.
 *
 * `StandardSchemaV1Sync` is assignable to `StandardSchemaV1` — it is a strict subtype.
 */
export interface StandardSchemaV1Sync<Input = unknown, Output = Input> extends StandardSchemaV1<Input, Output> {
    readonly '~standard': StandardSchemaV1Sync.Props<Input, Output>;
}

export namespace StandardSchemaV1Sync {
    export interface Props<Input = unknown, Output = Input> extends StandardSchemaV1.Props<Input, Output> {
        readonly validate: (value: unknown, options?: StandardSchemaV1.Options | undefined) => StandardSchemaV1.Result<Output>;
    }

    export type InferInput<Schema extends StandardTypedV1> = StandardTypedV1.InferInput<Schema>;
    export type InferOutput<Schema extends StandardTypedV1> = StandardTypedV1.InferOutput<Schema>;
}

// Type guards

export function isStandardJSONSchema(schema: unknown): schema is StandardJSONSchemaV1 {
    if (schema == null) return false;
    const schemaType = typeof schema;
    if (schemaType !== 'object' && schemaType !== 'function') return false;
    if (!('~standard' in (schema as object))) return false;
    const std = (schema as StandardJSONSchemaV1)['~standard'];
    return typeof std?.jsonSchema?.input === 'function' && typeof std?.jsonSchema?.output === 'function';
}

export function isStandardSchema(schema: unknown): schema is StandardSchemaV1 {
    if (schema == null) return false;
    const schemaType = typeof schema;
    if (schemaType !== 'object' && schemaType !== 'function') return false;
    if (!('~standard' in (schema as object))) return false;
    const std = (schema as StandardSchemaV1)['~standard'];
    return typeof std?.validate === 'function';
}

export function isStandardSchemaWithJSON(schema: unknown): schema is StandardSchemaWithJSON {
    return isStandardJSONSchema(schema) && isStandardSchema(schema);
}

// JSON Schema conversion

let warnedZodFallback = false;

/** JSON Schema draft targeted by every conversion; shared so pattern references above stay in lockstep. */
export const JSON_SCHEMA_CONVERSION_TARGET = 'draft-2020-12';

/**
 * Zod-specific `toJSONSchema` options, passed as `libraryOptions` on the Standard JSON
 * Schema path (scoped to `vendor === 'zod'`) and spread into the zod 4.0–4.1
 * `z.toJSONSchema()` fallback.
 *
 * The SDK validates payloads with the user's zod schema but ships the tool's *raw*
 * object — validation never replaces `structuredContent` — so the advertised schema
 * must describe the raw object's serialized wire form (#2464):
 *
 * - `unrepresentable: 'any'`: a single unrepresentable type (e.g. `z.bigint()`) degrades
 *   to an unconstrained `{}` instead of throwing and failing the entire `tools/list`.
 *   (BigInt *values* embedded as defaults or metadata — `.default(0n)`, `.meta({default: 1n})`
 *   — still throw: zod JSON-round-trips them in its own processors, outside this hook's reach.)
 * - `z.date()` is rewritten to `{type: 'string', format: 'date-time'}` — the shape
 *   `JSON.stringify` actually produces for a `Date` (and what the zod 3 converter emitted).
 * - Output objects drop `additionalProperties: false` unless the object is strict:
 *   zod validation tolerates unknown keys on plain `z.object()`, and the raw payload
 *   ships them.
 * - Output objects and enum-keyed records drop properties that may be legitimately
 *   absent from the shipped payload (`.default()`, undefined-accepting types) from
 *   `required`: zod fills defaults during validation, but ships the raw object.
 * - Output `.catch()` nodes drop their constraint keywords (`properties`, `required`,
 *   `additionalProperties`, and any non-object `type`, all unenforced on the raw
 *   value) but keep an emitted `type: 'object'` (with composition keywords reduced to
 *   member type skeletons), annotations, and `default`: catch-validation accepts any
 *   raw value — the fallback replaces it only in the parsed result, which the server
 *   never ships. The object-type signal is kept at every position (zod deduplicates
 *   reused instances, so the verdict must be position-independent) and is all the
 *   2025-era legacy-wrap object proof consumes at the root and in root-level
 *   compositions.
 *
 * Known residual gaps:
 * - A REQUIRED input field (tool `inputSchema`, prompt `argsSchema`) of a type JSON
 *   cannot carry makes the tool listed yet uncallable: `z.date()` advertises
 *   `string`/`date-time` and other unrepresentable types (`z.bigint()`, `z.map()`,
 *   `z.set()`, `z.symbol()`) an unconstrained `{}`, but input validation still runs
 *   the raw zod schema, which rejects every JSON payload. Use a JSON-representable
 *   type (`z.iso.date()`/`z.iso.datetime()`, `z.number()`, `z.record(...)`,
 *   `z.array(...)`) or make the field optional.
 * - Likewise a REQUIRED OUTPUT field of a loud unrepresentable type (`z.bigint()`,
 *   `z.map()`, `z.set()`) lists silently as a permanently-broken tool: bigint
 *   results fail JSON-RPC serialization, and Map/Set values ship as `{}` garbage
 *   that vacuously satisfies the unconstrained `{}` advertisement. A field-level
 *   throw would resurrect the whole-`tools/list` outage this fix eliminates, so
 *   only unrepresentable output ROOTS throw (see the output epilogue).
 * - The `type: 'object'` kept on degraded object-`.catch()` nodes is itself
 *   unenforced on the raw value: catch-validation accepts any raw, so a wrong-typed
 *   raw at an object-catch position ships and fails client re-validation while the
 *   scalar-catch spelling of the same tolerance passes. The keep is structurally
 *   forced by the 2025-era legacy-wrap object proof and zod's instance dedup.
 * - Dynamic catch values (`.catch(ctx => …)`) still throw inside zod's own
 *   catchProcessor before this hook runs ("Dynamic catch values are not supported
 *   in JSON Schema"), so one such tool still fails the entire `tools/list` — the
 *   degrade below covers static `.catch(value)` only.
 * - Output schemas containing `.transform()`/`.pipe()`/`z.coerce` still advertise the
 *   post-transform shape (`io: 'output'`) even though the server validates and ships
 *   the raw pre-transform value — rewriting pipe nodes to their input side per-node
 *   would break `$ref`s to registered schemas, and converting output advertisements
 *   with input semantics wholesale is a design decision that interacts with SEP-2106
 *   non-object output roots (see #2464 discussion).
 * - On zod 4.0–4.2.x, `toJSONSchema` skips the `override` hook on any node whose
 *   clone (`.describe()`/`.meta()`) appears in the same conversion (the
 *   `if (!seen.isParent)` guard in `v4/core/to-json-schema.js`, removed in zod
 *   4.3.0), so a schema reused both bare and via a clone leaves the bare node
 *   unsanitized. Full per-node sanitization requires zod >=4.3.0.
 * - The `z.date()` → `string`/`date-time` advertisement assumes a serializing
 *   transport. `InMemoryTransport` passes messages by reference with no JSON
 *   round-trip, so the raw `Date` the server must ship reaches a validating client
 *   as a `Date` instance and fails the advertised schema there.
 * - The loosen rewrite's `oneOf` → `anyOf` rename skips lexical `not`/`if`/`contains`
 *   positions, but a `.meta({not: {$ref: '#/properties/…'}})` aliasing a
 *   positive-position target observes the (legitimately) renamed schema, inverting
 *   polarity — the same node cannot read `anyOf` for its positive consumer and
 *   `oneOf` for a negated alias, so cross-polarity `$ref` aliasing into loosened
 *   subtrees stays untruthful.
 */
function zodConversionOptions(
    io: 'input' | 'output',
    loosened: { value: boolean }
): Pick<z.core.ToJSONSchemaParams, 'unrepresentable' | 'override'> {
    return {
        unrepresentable: 'any',
        override: ctx => {
            const def = ctx.zodSchema._zod.def;
            if ('id' in ctx.jsonSchema) {
                // zod copies registry metadata (`.meta({id: 'X'})`) verbatim, emitting a
                // literal draft-04 `id` keyword that Ajv v8 hard-rejects at COMPILE time
                // ('NOT SUPPORTED: keyword "id", use "$id"' — strict: false does not
                // help), so the SDK's own client could never validate the advertisement.
                // `$ref`s are path-based (#/$defs/Name) and cannot dangle; renaming to
                // `$id` would change base-URI resolution, so plain removal.
                delete ctx.jsonSchema.id;
            }
            if (def.type === 'date') {
                // Under `unrepresentable: 'any'` the node carries only user annotations
                // (`.describe()` / `.meta()`) — keep them and stamp the wire shape beside them.
                ctx.jsonSchema.type = 'string';
                ctx.jsonSchema.format = 'date-time';
                return;
            }
            if (io !== 'output') return;
            if (def.type === 'catch') {
                // `.catch()` accepts any raw value — invalid input is replaced by the
                // fallback only in the parsed result, which the server never ships — so
                // no inner constraint is enforced on the wire: drop the constraint
                // keywords — including a non-object `type`, which would reject the
                // wrong-typed raw values `.catch()` exists to tolerate — but KEEP an
                // emitted `type: 'object'` and reduce composition keywords
                // (`anyOf`/`oneOf`/`allOf`, emitted when the catch wraps a union or
                // intersection) to member type skeletons. `type: 'object'` is all the
                // 2025-era legacy-wrap object proof consumes, and the verdict must be
                // position-independent — zod deduplicates reused instances and runs
                // this hook once per instance, so one shared node can sit at both a
                // nested position and a root(-composition) position — losing the
                // object-type signal at the latter would flip the legacy-wrap
                // predicate (`isNonObjectJsonSchemaRoot`) and silently change the
                // wire shape.
                loosened.value = true;
                for (const key of Object.keys(ctx.jsonSchema)) {
                    if (key === 'type' && ctx.jsonSchema.type === 'object') continue;
                    if ((key === 'anyOf' || key === 'oneOf' || key === 'allOf') && Array.isArray(ctx.jsonSchema[key])) {
                        const skeletons = (ctx.jsonSchema[key] as unknown[]).map(member => compositionTypeSkeleton(member));
                        // `oneOf` means EXACTLY one: with member constraints stripped, the
                        // skeletons are indistinguishable and every payload would match all
                        // of them — advertise the honest loosening `anyOf` instead
                        // (wrap-neutral: `isProvablyObjectShapedRoot` treats the
                        // composition keywords identically).
                        if (key === 'oneOf') delete ctx.jsonSchema[key];
                        ctx.jsonSchema[key === 'oneOf' ? 'anyOf' : key] = skeletons;
                        continue;
                    }
                    // Reference TARGETS and containers constrain no instance value —
                    // deleting them only dangles inbound `$ref`s and makes the
                    // advertisement uncompilable.
                    if (key === '$anchor' || key === '$dynamicAnchor' || key === '$id' || key === '$defs') continue;
                    // Only schema-carrying and enforced keywords constrain validation;
                    // everything else — vocabulary annotations, `x-*` extensions, custom
                    // `.meta()` keys — is annotation-opaque and kept.
                    if (SCHEMA_CARRYING_JSON_SCHEMA_KEYWORDS.has(key) || ENFORCED_JSON_SCHEMA_KEYWORDS.has(key)) {
                        delete ctx.jsonSchema[key];
                    }
                }
                return;
            }
            if (def.type === 'record') {
                // Enum-keyed records emit a `required` list too. Every key shares the one
                // value schema, so tolerance for missing keys is all-or-nothing.
                if (Array.isArray(ctx.jsonSchema.required) && fieldAcceptsMissingKey(def.valueType)) {
                    loosened.value = true;
                    delete ctx.jsonSchema.required;
                }
                return;
            }
            if (def.type === 'array') {
                // JSON.stringify turns an undefined array ELEMENT into `null` (unlike an
                // undefined-valued object key, which it drops), so a tolerant element
                // (`.default()`/`.prefault()`, …) may ship as null — the advertised item
                // subschema must accept it.
                const items = ctx.jsonSchema.items;
                if (typeof items === 'object' && items !== null && !Array.isArray(items) && hasStructuralMissingKeyTolerance(def.element)) {
                    loosened.value = true;
                    ctx.jsonSchema.items = { anyOf: [items, { type: 'null' }] };
                }
                return;
            }
            if (def.type === 'tuple') {
                // Same wire mechanism per prefix position.
                const prefixItems = ctx.jsonSchema.prefixItems;
                if (Array.isArray(def.items) && Array.isArray(prefixItems)) {
                    for (const [index, item] of def.items.entries()) {
                        const emitted = prefixItems[index];
                        if (typeof emitted === 'object' && emitted !== null && hasStructuralMissingKeyTolerance(item)) {
                            loosened.value = true;
                            prefixItems[index] = { anyOf: [emitted, { type: 'null' }] };
                        }
                    }
                }
                // ... and for the REST element, whose emitted subschema lands under
                // `items` in draft-2020-12.
                const restItems = ctx.jsonSchema.items;
                if (
                    def.rest !== undefined &&
                    typeof restItems === 'object' &&
                    restItems !== null &&
                    !Array.isArray(restItems) &&
                    hasStructuralMissingKeyTolerance(def.rest)
                ) {
                    loosened.value = true;
                    ctx.jsonSchema.items = { anyOf: [restItems, { type: 'null' }] };
                }
                return;
            }
            if (
                def.type === 'literal' &&
                Array.isArray(def.values) &&
                def.values.some(value => typeof value === 'number' && !Number.isFinite(value))
            ) {
                // Non-finite number literal values (Infinity/-Infinity/NaN) serialize to
                // null, and zod's own emission is the self-contradictory
                // {type: 'number', const: null} that nothing satisfies — wrap it so the
                // wire form validates.
                loosened.value = true;
                wrapConstraintsInAnyOf(ctx.jsonSchema, { type: 'null' });
                return;
            }
            if (def.type === 'file') {
                // A File value serializes to `{}` on the wire (no enumerable own
                // properties, no toJSON) while zod emits string/binary — accept the
                // actual wire form too.
                loosened.value = true;
                wrapConstraintsInAnyOf(ctx.jsonSchema, { type: 'object' });
                return;
            }
            if (def.type !== 'object') return;
            const isStrict = def.catchall?._zod.def.type === 'never';
            if (!isStrict && ctx.jsonSchema.additionalProperties === false) {
                delete ctx.jsonSchema.additionalProperties;
            }
            const required = ctx.jsonSchema.required;
            if (Array.isArray(required)) {
                // Keyed on the zod shape, not the emitted JSON: a registered `.default()`
                // hides its `default` keyword behind a `$ref`, and undefined-accepting
                // fields (`z.any()`, `z.unknown()`, …) never emit one yet may be dropped
                // from the wire payload by JSON.stringify.
                const filtered = required.filter(name => !fieldAcceptsMissingKey(def.shape[name]));
                if (filtered.length !== required.length) {
                    loosened.value = true;
                    if (filtered.length === 0) delete ctx.jsonSchema.required;
                    else ctx.jsonSchema.required = filtered;
                }
            }
        }
    };
}

/**
 * Recursively moves every `oneOf` in an emitted (already-loosened) JSON Schema tree
 * to `anyOf`. Used when a conversion's catch degrade or required-filter fired: the
 * loosened members of an untouched parent `oneOf` (e.g. a discriminated union whose
 * catch-wrapped discriminators were degraded) may have become mutually satisfiable,
 * inverting exactly-one semantics into reject-everything.
 */
function rewriteOneOfToAnyOf(node: unknown, seen: Set<unknown> = new Set()): void {
    if (typeof node !== 'object' || node === null || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
        for (const item of node) rewriteOneOfToAnyOf(item, seen);
        return;
    }
    const record = node as Record<string, unknown>;
    if (Array.isArray(record.oneOf)) {
        if (record.anyOf === undefined) {
            record.anyOf = record.oneOf;
        } else {
            // A user `.meta({anyOf})` can coexist with the emitted `oneOf` — preserve
            // conjunction semantics without clobbering it: keywords on one node
            // combine with AND, so `{anyOf: members}` under `allOf` is equivalent.
            const allOf = Array.isArray(record.allOf) ? record.allOf : (record.allOf = []);
            allOf.push({ anyOf: record.oneOf });
            // The relocated members' objectness becomes invisible to the wrap proof's
            // every()-member rule once user conjuncts coexist (e.g. a .meta({allOf:
            // [{minProperties: 1}]})) — stamp the sound explicit type here (the value
            // must satisfy the pushed conjunct), preserving the pre-#2464 stamp these
            // roots got via their emitted oneOf.
            if (record.type === undefined && isProvablyObjectShapedRoot({ anyOf: record.oneOf })) {
                record.type = 'object';
            }
        }
        delete record.oneOf;
    }
    for (const [key, value] of Object.entries(record)) {
        // Only schema-carrying keywords are recursed into: everything else —
        // vocabulary annotations, `const`/`enum` data, `x-*` extensions, custom
        // `.meta()` keys — carries user DATA whose literal `oneOf` keys must not be
        // renamed.
        if (!SCHEMA_CARRYING_JSON_SCHEMA_KEYWORDS.has(key)) continue;
        // oneOf→anyOf is a loosening only in POSITIVE polarity: under `not` it
        // inverts (a payload matching ≥2 members passed `not {oneOf}` but fails
        // `not {anyOf}`), under `if` it can flip which then/else branch applies,
        // and under `contains` it raises the contains-count, tightening against a
        // sibling `maxContains` (zod never emits `contains`, so skipping is
        // regression-free).
        if (key === 'not' || key === 'if' || key === 'contains') continue;
        // Schema MAPS hold schemas under user-chosen names that may collide with
        // annotation keywords (a property literally named `description` still
        // carries a schema) — recurse into every value unconditionally.
        if (SCHEMA_MAP_JSON_SCHEMA_KEYWORDS.has(key) && typeof value === 'object' && value !== null && !Array.isArray(value)) {
            if (seen.has(value)) continue;
            seen.add(value);
            for (const subschema of Object.values(value as Record<string, unknown>)) rewriteOneOfToAnyOf(subschema, seen);
            continue;
        }
        rewriteOneOfToAnyOf(value, seen);
    }
}

/**
 * Moves a node's constraint keywords (schema-carrying + enforced) into `anyOf[0]`,
 * adding `alternative` as `anyOf[1]`, while leaving annotation-opaque keys (and
 * `default`) at the node top level where consumers read them — an annotation buried
 * inside an applicator branch the wire payload never matches applies to nothing
 * under 2020-12 annotation-collection semantics.
 */
function wrapConstraintsInAnyOf(node: Record<string, unknown>, alternative: Record<string, unknown>): void {
    const constrained: Record<string, unknown> = {};
    for (const key of Object.keys(node)) {
        if (SCHEMA_CARRYING_JSON_SCHEMA_KEYWORDS.has(key) || ENFORCED_JSON_SCHEMA_KEYWORDS.has(key)) {
            constrained[key] = node[key];
            delete node[key];
        }
    }
    node.anyOf = [constrained, alternative];
}

/**
 * Reduces a degraded node's composition member to its type skeleton — `type` plus
 * recursively-skeletonized nested compositions, nothing else — so the output
 * epilogue's `isProvablyObjectShapedRoot` proof survives the `.catch()` degrade
 * without advertising any unenforced member constraint.
 */
function compositionTypeSkeleton(node: unknown): Record<string, unknown> {
    if (typeof node !== 'object' || node === null) return {};
    const source = node as Record<string, unknown>;
    const skeleton: Record<string, unknown> = {};
    // Only `type: 'object'` feeds the proof; any other type is an unenforced constraint.
    if (source.type === 'object') skeleton.type = 'object';
    // Reference TARGETS constrain nothing — dropping them would dangle inbound $refs.
    for (const referenceKey of ['$anchor', '$dynamicAnchor', '$id'] as const) {
        if (source[referenceKey] !== undefined) skeleton[referenceKey] = source[referenceKey];
    }
    for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
        if (Array.isArray(source[key])) {
            // Skeletonized `oneOf` members are indistinguishable, so exactly-one
            // semantics would reject every payload — emit `anyOf` instead.
            skeleton[key === 'oneOf' ? 'anyOf' : key] = (source[key] as unknown[]).map(member => compositionTypeSkeleton(member));
        }
    }
    return skeleton;
}

/**
 * JSON Schema keywords whose values carry SCHEMAS (directly, as arrays of schemas, or
 * as name→schema maps). Every key outside this set and
 * {@linkcode ENFORCED_JSON_SCHEMA_KEYWORDS} — vocabulary annotations, `x-*` vendor
 * extensions, and custom `.meta()` keys zod merges verbatim — is annotation-opaque:
 * 2020-12 validators ignore unknown keywords, so such keys are kept and never
 * recursed into.
 */
const SCHEMA_CARRYING_JSON_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
    'properties',
    'patternProperties',
    '$defs',
    'dependentSchemas',
    'items',
    'prefixItems',
    'anyOf',
    'oneOf',
    'allOf',
    'not',
    'if',
    'then',
    'else',
    'additionalProperties',
    'propertyNames',
    'contains',
    'unevaluatedProperties',
    'unevaluatedItems'
]);

/** Schema-map keywords among the above: their KEYS are user-chosen names, their values schemas. */
const SCHEMA_MAP_JSON_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set(['properties', 'patternProperties', '$defs', 'dependentSchemas']);

/**
 * Non-schema-carrying keywords that validators ENFORCE — the `.catch()` degrade must
 * delete them (catch-validation enforces nothing on the raw value), unlike unknown
 * annotation-opaque keys, which are kept.
 */
const ENFORCED_JSON_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
    'type',
    'const',
    'enum',
    'required',
    'format',
    'pattern',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'uniqueItems',
    'minContains',
    'maxContains',
    'minProperties',
    'maxProperties',
    'dependentRequired',
    'contentEncoding',
    'contentMediaType',
    'contentSchema',
    '$ref',
    '$dynamicRef',
    '$dynamicAnchor',
    '$anchor',
    '$id',
    'id'
]);

/**
 * Whether a raw payload that omits this field still passes validation (zod treats a
 * missing key as `undefined` — true for `.default()`/`.prefault()`, `z.any()`,
 * `z.unknown()`, `z.undefined()`, and unions with them), so the wire schema must not
 * advertise the field as `required`. A probe that throws, rejects, or goes async (a
 * `.transform()` choking on `undefined` does all three depending on the zod version)
 * cannot demonstrate tolerance, so such fields conservatively stay required.
 */
function fieldAcceptsMissingKey(field: z.core.$ZodType | undefined): boolean {
    if (field === undefined) return false;
    // Defaulted fields accept a missing key by construction (zod fills the default
    // before any refinement or transform runs) — decide structurally, since an async
    // stage (`.refine(async ...)`, `.transform(async ...)`) would push the probe
    // below to a Promise and wrongly keep the field required. The walk also covers
    // static `.catch()`, undefined-accepting leaves (`z.any()`/`z.unknown()`),
    // Symbol-/function-typed fields (JSON.stringify drops such keys entirely), union
    // members, and defaults hidden inside a pipe (`.default(7).transform(...)`,
    // `z.preprocess(fn, z.number().default(7))`).
    if (hasStructuralMissingKeyTolerance(field)) return true;
    try {
        const result = field['~standard'].validate(undefined);
        if (result instanceof Promise) {
            // Never leave a floating rejection: an unhandled one crashes the process.
            result.catch(() => {});
            return false;
        }
        return result.issues === undefined;
    } catch {
        return false;
    }
}

/**
 * Whether the field's def chain carries a node that makes a missing key tolerable by
 * construction — `default`/`prefault` (the default fills), a static `catch` (any
 * input, including `undefined`, is replaced by the fallback), `optional`, an
 * undefined-accepting leaf (`z.any()`/`z.unknown()`/`z.undefined()`/`z.void()`, or a
 * literal whose values include `undefined`), or a Symbol-/function-typed leaf
 * (JSON.stringify drops such keys from the payload entirely) — unwinding pipe sides,
 * lazies, transparent wrappers, union members (ANY tolerant member suffices: zod
 * tries members and the tolerant one succeeds), and intersections with EVERY-side
 * semantics (`undefined` must parse through both sides). Deciding structurally matters
 * because an async stage (`.refine(async ...)`, `.transform(async ...)`) pushes the
 * validate-probe to a Promise. All checks err loosen-only: a false positive merely
 * drops a field from the advertised `required`, which can never make a validating
 * client reject a shipped payload. `ancestors` tracks the current traversal path so
 * recursive lazies stay bounded.
 */
function hasStructuralMissingKeyTolerance(field: unknown, ancestors: ReadonlySet<unknown> = new Set()): boolean {
    if (typeof field !== 'object' || field === null || ancestors.has(field)) return false;
    const def = (
        field as {
            _zod?: {
                def?: {
                    type?: string;
                    innerType?: unknown;
                    getter?: unknown;
                    in?: unknown;
                    out?: unknown;
                    options?: unknown;
                    left?: unknown;
                    right?: unknown;
                    values?: unknown;
                };
            };
        }
    )._zod?.def;
    if (def === undefined || typeof def.type !== 'string') return false;
    // `catch` and `optional` must be recognized BEFORE the wrapper unwind below
    // would step past the very node granting tolerance (bare `.optional()` fields
    // are already excluded from `required` by zod's emitter, but one inside a pipe
    // — `z.string().optional().transform(async ...)` — is not).
    if (def.type === 'default' || def.type === 'prefault' || def.type === 'catch' || def.type === 'optional') return true;
    if (def.type === 'any' || def.type === 'unknown' || def.type === 'undefined' || def.type === 'void') return true;
    if (def.type === 'symbol' || def.type === 'function') return true;
    if (def.type === 'literal' && Array.isArray(def.values) && def.values.includes(undefined)) return true;
    const path = new Set(ancestors);
    path.add(field);
    if (def.type === 'lazy' && typeof def.getter === 'function') {
        try {
            return hasStructuralMissingKeyTolerance((def.getter as () => unknown)(), path);
        } catch {
            return false;
        }
    }
    if (def.type === 'pipe' && def.in !== undefined) {
        if (hasStructuralMissingKeyTolerance(def.in, path)) return true;
        // `z.preprocess(fn, inner)` builds the opposite pipe — the transform sits at
        // `def.in` and the tolerant node (e.g. a default) at `def.out`.
        const inDef = (def.in as { _zod?: { def?: { type?: string } } })._zod?.def;
        if (inDef?.type === 'transform' && def.out !== undefined) {
            return hasStructuralMissingKeyTolerance(def.out, path);
        }
        return false;
    }
    if (def.type === 'union' && Array.isArray(def.options)) {
        return def.options.some(option => hasStructuralMissingKeyTolerance(option, path));
    }
    if (def.type === 'intersection' && def.left !== undefined && def.right !== undefined) {
        // EVERY-side semantics: `undefined` must parse through BOTH sides (each
        // filling its default) for zod to merge the results.
        return hasStructuralMissingKeyTolerance(def.left, path) && hasStructuralMissingKeyTolerance(def.right, path);
    }
    if (WRAPPER_ZOD_DEF_TYPES.has(def.type) && def.innerType !== undefined) {
        return hasStructuralMissingKeyTolerance(def.innerType, path);
    }
    return false;
}

/** Options for {@linkcode standardSchemaToJsonSchema}. */
export interface StandardSchemaToJsonSchemaOptions {
    /**
     * How types JSON Schema cannot represent (`z.date()`, `z.bigint()`, …) are handled
     * for zod schemas:
     *
     * - `'wire'` (default) — degrade gracefully: `z.date()` becomes
     *   `{type: 'string', format: 'date-time'}` (the shape `JSON.stringify` puts on the
     *   wire for a `Date`) and other unrepresentable types become an unconstrained
     *   schema, so one field cannot fail an entire `tools/list` response (#2464).
     * - `'throw'` — surface zod's conversion error. The elicitation path uses this: its
     *   restricted form grammar must reject shapes it cannot round-trip, and a silently
     *   rewritten `string`/`date-time` request would elicit a string that the original
     *   `z.date()` schema can never re-validate on handler re-entry.
     */
    unrepresentable?: 'wire' | 'throw';
}

/**
 * Converts a StandardSchema to JSON Schema for use as an MCP tool/prompt schema.
 *
 * MCP requires `type: "object"` at the root of tool `inputSchema` and prompt
 * argument schemas; `outputSchema` may have any JSON Schema root (SEP-2106).
 * Zod's discriminated unions emit `{oneOf: [...]}` without a top-level `type`,
 * so for `io: 'input'` this function defaults `type` to `"object"` when absent
 * and throws on an explicit non-object `type` (e.g. `z.string()`). For
 * `io: 'output'` a non-object root is returned as-is; the `"object"` default is
 * applied only when the root is provably object-shaped.
 */
export function standardSchemaToJsonSchema(
    schema: StandardJSONSchemaV1,
    io: 'input' | 'output' = 'input',
    options?: StandardSchemaToJsonSchemaOptions
): Record<string, unknown> {
    const std = schema['~standard'];
    const loosened = { value: false };
    const zodOptions = options?.unrepresentable === 'throw' ? undefined : zodConversionOptions(io, loosened);
    let result: Record<string, unknown>;
    if (std.jsonSchema) {
        result = std.jsonSchema[io]({
            target: JSON_SCHEMA_CONVERSION_TARGET,
            // Non-zod vendors receive no libraryOptions, so their behavior is unchanged.
            libraryOptions: std.vendor === 'zod' ? zodOptions : undefined
        });
    } else if (std.vendor === 'zod') {
        // zod 4.0–4.1 implements StandardSchemaV1 but not StandardJSONSchemaV1 (`~standard.jsonSchema`).
        // The SDK already bundles zod 4, so fall back to its converter rather than crashing on tools/list.
        // zod 3 schemas (which also report vendor 'zod') have `_def` but not `_zod`; the SDK-bundled
        // zod 4 `z.toJSONSchema()` cannot introspect them, so throw a clear error instead of crashing.
        if (!('_zod' in (schema as object))) {
            throw new Error(
                'Schema appears to be from zod 3, which the SDK cannot convert to JSON Schema. ' +
                    'Upgrade to zod >=4.2.0, or wrap your JSON Schema with fromJsonSchema().'
            );
        }
        if (!warnedZodFallback) {
            warnedZodFallback = true;
            console.warn(
                '[mcp-sdk] Your zod version does not implement `~standard.jsonSchema` (added in zod 4.2.0). ' +
                    'Falling back to z.toJSONSchema(). Upgrade to zod >=4.2.0 to silence this warning.'
            );
        }
        result = z.toJSONSchema(schema as unknown as z.ZodType, {
            target: JSON_SCHEMA_CONVERSION_TARGET,
            io,
            ...zodOptions
        }) as Record<string, unknown>;
    } else {
        throw new Error(
            `Schema library "${std.vendor}" does not implement StandardJSONSchemaV1 (\`~standard.jsonSchema\`). ` +
                `Upgrade to a version that does, or wrap your JSON Schema with fromJsonSchema().`
        );
    }
    if (io === 'output' && loosened.value) {
        // Exactly-one semantics cannot survive member loosening: once the catch
        // degrade or the required-filter fired anywhere in this conversion, `oneOf`
        // members (zod's discriminated-union emission) may have become mutually
        // satisfiable — e.g. catch-wrapped discriminators — and Ajv would reject
        // every payload with "must match exactly one schema in oneOf". Rewrite to
        // the honest `anyOf` (loosen-only and wrap-neutral:
        // `isProvablyObjectShapedRoot` treats the composition keywords identically).
        rewriteOneOfToAnyOf(result);
    }
    if (io === 'output') {
        // SEP-2106: outputSchema may have any JSON Schema root. An explicit `type` (object or
        // not) is returned as-is. A typeless root only gets `type:'object'` defaulted when it is
        // PROVABLY object-shaped — either it carries object keywords at the root, or every
        // member of a root `oneOf`/`anyOf`/`allOf` is itself `type:'object'` (the
        // `z.discriminatedUnion(...)`, `z.union([z.object(...), ...])`, `z.intersection(...)`
        // cases). Those pre-SEP schemas were valid 2025 wire data via the unconditional stamp,
        // so the stamp is kept where it is provably safe. A typeless root that is NOT provably
        // object-shaped (e.g. `z.union([z.string(), z.number()])` → `{anyOf:[…]}`) is returned
        // as-is — stamping there would be self-contradictory. Anything that does not end up
        // `type:'object'` is wrapped as `{type:'object', properties:{result:…}}` by the 2025
        // codec's legacy projection (see `wire/rev2025-11-25/legacyWrap.ts`).
        // Loudness parity BEFORE the explicit-type early return: a loud-valued
        // literal root (bigint, or undefined filtered from the value list) emits an
        // explicit type under `unrepresentable: 'any'`, yet no such result can ever
        // ride JSON truthfully — pre-#2464 these threw loudly.
        if (isLoudLiteralOutputRoot(schema)) {
            throw new Error(
                `MCP tool and prompt schemas must describe objects (got a non-object literal schema). ` +
                    `Wrap your schema in z.object({...}) or equivalent.`
            );
        }
        if (result.type !== undefined) return result;
        // Loudness parity for misregistered OUTPUT roots too: an unrepresentable
        // non-object root (z.bigint(), z.map(), unions of them) threw at tools/list
        // pre-#2464 and must keep doing so — post-degrade it would list silently as
        // a permanently-broken tool (bigint results even fail JSON-RPC
        // serialization; Map/Set ship `{}` garbage). Representable non-object roots
        // (legal per SEP-2106) carry an explicit `type` and returned above; quiet
        // shapes keep listing.
        const outputVerdict = nonObjectTypelessRootVerdict(schema, 'output');
        if (outputVerdict !== undefined && outputVerdict.loud) {
            throw new Error(
                `MCP tool and prompt schemas must describe objects (got a non-object ${outputVerdict.type} schema). ` +
                    `Wrap your schema in z.object({...}) or equivalent.`
            );
        }
        // The stamp runs AFTER the guard: a loud conjunct (e.g.
        // `z.intersection(z.object(...), z.bigint())`) must throw even when an object
        // conjunct could prove the root.
        if (isProvablyObjectShapedRoot(result)) return { type: 'object', ...result };
        return result;
    }
    if (result.type !== undefined && result.type !== 'object') {
        throw new Error(
            `MCP tool and prompt schemas must describe objects (got type: ${JSON.stringify(result.type)}). ` +
                `Wrap your schema in z.object({...}) or equivalent.`
        );
    }
    // `unrepresentable: 'any'` erases the explicit non-object `type` the guard above keys
    // on (e.g. a bare `z.bigint()` root emits `{}`); recover the signal from the zod def
    // so misregistered roots keep failing loudly instead of being advertised as
    // permanently-uncallable `{type: 'object'}` tools.
    if (result.type === undefined) {
        const verdict = nonObjectTypelessRootVerdict(schema, 'input');
        // Quiet verdicts (compositions of only non-finite number literals) listed
        // silently pre-#2464 and keep the unconditional stamp below.
        if (verdict !== undefined && verdict.loud) {
            throw new Error(
                `MCP tool and prompt schemas must describe objects (got a non-object ${verdict.type} schema). ` +
                    `Wrap your schema in z.object({...}) or equivalent.`
            );
        }
    }
    return { type: 'object', ...result };
}

/**
 * Whether an OUTPUT root unwinds (through transparent wrappers, lazies, and pipe OUT
 * sides) to a literal with loud values (bigint, or `undefined` beside representable
 * co-values that zod filters out). Such emissions carry an explicit `type` under
 * `unrepresentable: 'any'` — bypassing the typeless-root guard via the explicit-type
 * early return — yet the raw values server-side validation accepts can never ride
 * JSON truthfully. Pre-#2464 all of them threw loudly.
 */
function isLoudLiteralOutputRoot(schema: unknown, ancestors: ReadonlySet<unknown> = new Set()): boolean {
    if (typeof schema !== 'object' || schema === null || ancestors.has(schema)) return false;
    const def = (
        schema as {
            _zod?: { def?: { type?: string; innerType?: unknown; getter?: unknown; in?: unknown; out?: unknown; values?: unknown } };
        }
    )._zod?.def;
    if (def === undefined || typeof def.type !== 'string') return false;
    const path = new Set(ancestors);
    path.add(schema);
    if (def.type === 'lazy' && typeof def.getter === 'function') {
        try {
            return isLoudLiteralOutputRoot((def.getter as () => unknown)(), path);
        } catch {
            return false;
        }
    }
    if (def.type === 'pipe') {
        // Output conversion processes the OUT side; a bare transform there has no
        // literal of its own, so fall back to the IN side (mirroring the verdict walk).
        if (def.out !== undefined) {
            if (isLoudLiteralOutputRoot(def.out, path)) return true;
            const outDef = (def.out as { _zod?: { def?: { type?: string } } })._zod?.def;
            if (outDef?.type === 'transform' && def.in !== undefined) {
                return isLoudLiteralOutputRoot(def.in, path);
            }
        }
        return false;
    }
    if (WRAPPER_ZOD_DEF_TYPES.has(def.type) && def.innerType !== undefined) {
        return isLoudLiteralOutputRoot(def.innerType, path);
    }
    return def.type === 'literal' && nonObjectLiteralLoudness(def.values) === 'loud';
}

/**
 * The verdict for a zod root that emits a typeless node yet provably cannot describe
 * an object, or `undefined` when the root may. Unwraps transparent wrappers, lazies,
 * and pipe input sides, then recurses into compositions: a union is non-object when
 * EVERY member is, an intersection when ANY side is (the value must satisfy both). A
 * member counts as non-object ONLY when it unwinds to a genuinely unrepresentable
 * type, or to a literal carrying unrepresentable values — representable members
 * (including single-type literals, zod's idiomatic enum spelling, and representable
 * non-object types like `z.string()`) keep the composition accepted, exactly as such
 * roots converted before #2464.
 *
 * The verdict carries loudness for the loudness-parity contract: `loud` shapes made
 * pre-#2464 conversion throw (bigint/symbol/date/…, literals with undefined or
 * bigint values) and must keep throwing; `quiet` shapes (non-finite number and
 * symbol literals, which zod silently emitted without a conversion error) listed
 * silently pre-#2464 and must keep listing — the guard throws only for a
 * loud-containing verdict. `ancestors` tracks only the current traversal path, so a shared instance
 * gets a real verdict at every occurrence while recursive lazies stay bounded.
 */
function nonObjectTypelessRootVerdict(
    schema: unknown,
    io: 'input' | 'output',
    ancestors: ReadonlySet<unknown> = new Set()
): { type: string; loud: boolean } | undefined {
    if (typeof schema !== 'object' || schema === null || ancestors.has(schema)) return undefined;
    const def = (
        schema as {
            _zod?: {
                def?: {
                    type?: string;
                    innerType?: unknown;
                    getter?: unknown;
                    in?: unknown;
                    out?: unknown;
                    options?: unknown;
                    left?: unknown;
                    right?: unknown;
                    values?: unknown;
                };
            };
        }
    )._zod?.def;
    if (def === undefined || typeof def.type !== 'string') return undefined;
    const path = new Set(ancestors);
    path.add(schema);
    if (def.type === 'lazy' && typeof def.getter === 'function') {
        try {
            return nonObjectTypelessRootVerdict((def.getter as () => unknown)(), io, path);
        } catch {
            return undefined;
        }
    }
    if (def.type === 'pipe') {
        // Loudness parity must anchor to the side zod's conversion actually
        // processed: input conversion reads `def.in`, output conversion `def.out` —
        // pre-#2464, `z.date().transform(d => d.toISOString()).pipe(z.string().nullable())`
        // converted fine on the output path (only its OUT side was visited).
        const primary = io === 'output' ? def.out : def.in;
        const secondary = io === 'output' ? def.in : def.out;
        if (primary !== undefined) {
            const verdict = nonObjectTypelessRootVerdict(primary, io, path);
            if (verdict !== undefined) return verdict;
            // A bare transform on the processed side has no verdict of its own — the
            // real schema sits on the other side (`z.preprocess(fn, inner)` on input;
            // on output, zod threw 'Transforms cannot be represented' pre-#2464, so
            // consulting `def.in` keeps genuinely-unrepresentable inputs loud while
            // representable ones degrade gracefully).
            const primaryDef = (primary as { _zod?: { def?: { type?: string } } })._zod?.def;
            if (primaryDef?.type === 'transform' && secondary !== undefined) {
                return nonObjectTypelessRootVerdict(secondary, io, path);
            }
        }
        return undefined;
    }
    if (WRAPPER_ZOD_DEF_TYPES.has(def.type) && def.innerType !== undefined) {
        return nonObjectTypelessRootVerdict(def.innerType, io, path);
    }
    if (def.type === 'union' && Array.isArray(def.options) && def.options.length > 0) {
        const verdicts = def.options.map(option => nonObjectTypelessRootVerdict(option, io, path));
        if (verdicts.includes(undefined)) return undefined;
        return { type: 'union', loud: verdicts.some(verdict => verdict?.loud === true) };
    }
    if (def.type === 'intersection' && def.left !== undefined && def.right !== undefined) {
        const left = nonObjectTypelessRootVerdict(def.left, io, path);
        const right = nonObjectTypelessRootVerdict(def.right, io, path);
        if (left === undefined && right === undefined) return undefined;
        // A date side is quiet on the output path as a root or union member (the
        // override makes those emissions wire-truthful), but no value can satisfy
        // BOTH intersection sides when one is a Date — every date-containing
        // intersection threw pre-#2464, so parity keeps them loud here.
        const loudDateSide = io === 'output' && (left?.type === 'date' || right?.type === 'date');
        return { type: 'intersection', loud: left?.loud === true || right?.loud === true || loudDateSide };
    }
    if (def.type === 'literal') {
        const loudness = nonObjectLiteralLoudness(def.values);
        return loudness === undefined ? undefined : { type: 'literal', loud: loudness === 'loud' };
    }
    if (def.type === 'date') {
        // The date override rewrites every date node to its true wire form
        // (string/date-time), so a date-rooted OUTPUT emission is wire-truthful and
        // must keep listing (`z.date().nullable()` is a working 'timestamp or null'
        // tool); on INPUT no JSON payload satisfies raw z.date() validation, so date
        // members stay loud there.
        return { type: 'date', loud: io === 'input' };
    }
    if (def.type === 'never') {
        // z.never() matches no value: it can never make a union satisfiable or
        // object-shaped. Quiet, though — bare/all-never shapes emitted `{not: {}}`
        // without throwing pre-#2464 and must keep listing; the verdict only turns a
        // union loud when a loud co-member (e.g. a bigint) is present, restoring the
        // pre-#2464 throw for those.
        return { type: 'never', loud: false };
    }
    if (def.type === 'file') {
        // A File can never ride JSON: it cannot make a union JSON-satisfiable. Quiet —
        // bare z.file() roots throw via the explicit-type guard (string/binary
        // emission) and file+representable shapes listed silently pre-#2464; only a
        // loud co-member restores the pre-#2464 throw.
        return { type: 'file', loud: false };
    }
    return NON_OBJECT_UNREPRESENTABLE_TYPES.has(def.type) ? { type: def.type, loud: true } : undefined;
}

/**
 * The non-object loudness of a literal's values, or `undefined` when the literal may
 * be JSON-satisfiable. `'loud'`: a value zod's own converter threw on pre-#2464
 * (`undefined`, bigint) — such roots must keep failing loudly. `'quiet'`: non-finite
 * numbers (`Infinity`/`-Infinity`/`NaN`, silently emitted as
 * `{type: 'number', const: null}`) and symbol values (silently emitted as
 * `{type: 'symbol'}`) — non-object, but such roots listed silently pre-#2464 and
 * must keep listing. Any representable value (string, finite number, boolean, null)
 * makes the literal satisfiable via JSON: `undefined`
 * (`z.union([z.literal('admin'), z.literal('member')])`, zod's idiomatic enum
 * spelling, and mixed-type lists like `z.literal(['a', 1])` all keep converting
 * exactly as they did pre-#2464).
 */
function nonObjectLiteralLoudness(values: unknown): 'loud' | 'quiet' | undefined {
    if (!Array.isArray(values) || values.length === 0) return 'loud';
    let representable = false;
    let quiet = false;
    for (const value of values) {
        if (value === null) {
            representable = true;
            continue;
        }
        const valueType = typeof value;
        if (valueType === 'undefined' || valueType === 'bigint') {
            // These literal VALUES threw pre-#2464 regardless of co-values.
            return 'loud';
        }
        if (valueType === 'symbol') {
            // Not JSON-satisfiable, but zod silently emitted {type: 'symbol'} for it
            // pre-#2464 — quiet, like non-finite numbers.
            quiet = true;
            continue;
        }
        if (valueType === 'number' && !Number.isFinite(value as number)) {
            quiet = true;
            continue;
        }
        if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') {
            representable = true;
            continue;
        }
        return 'loud'; // unknown value kind — conservative
    }
    if (representable) return undefined;
    return quiet ? 'quiet' : undefined;
}

/**
 * Zod def types that are genuinely unrepresentable in JSON Schema (they degrade to a
 * typeless `{}` under `unrepresentable: 'any'`) and whose values can never be a JSON
 * object — the root guards must keep rejecting roots and compositions built from
 * them. `custom` and bare `transform` are deliberately excluded (they can
 * legitimately accept objects); `date` gets a dedicated io-aware branch (loud on
 * input, quiet on output where the override makes it wire-truthful); and typeless
 * literals are classified separately by value in
 * {@linkcode nonObjectLiteralLoudness}.
 */
const NON_OBJECT_UNREPRESENTABLE_TYPES: ReadonlySet<string> = new Set([
    'bigint',
    'symbol',
    'map',
    'set',
    'void',
    'undefined',
    'nan',
    'function'
]);

/** Transparent wrapper def types whose `innerType` carries the real root semantics. */
const WRAPPER_ZOD_DEF_TYPES: ReadonlySet<string> = new Set([
    'optional',
    'nonoptional',
    'nullable',
    'readonly',
    'default',
    'prefault',
    'catch',
    'promise'
]);

/**
 * A typeless JSON Schema root is "provably object-shaped" when either it carries object keywords
 * directly (`properties`/`patternProperties`/`additionalProperties`/`required`), or it is a
 * composition (`oneOf`/`anyOf`/`allOf`) whose every member is itself `type:'object'` or recursively
 * provably object-shaped (e.g. a nested `discriminatedUnion`). `$ref` is not followed. Used to
 * decide whether stamping `type:'object'` is safe (redundant-but-valid) versus self-contradictory.
 */
function isProvablyObjectShapedRoot(schema: Record<string, unknown>): boolean {
    if ('properties' in schema || 'patternProperties' in schema || 'additionalProperties' in schema || 'required' in schema) {
        return true;
    }
    const isObjectMember = (member: unknown): boolean =>
        member !== null &&
        typeof member === 'object' &&
        ((member as Record<string, unknown>).type === 'object' || isProvablyObjectShapedRoot(member as Record<string, unknown>));
    // Keywords on one node AND-combine, so ANY present composition key proving
    // objectness suffices (a first-key-wins rule breaks when the loosen rewrite
    // relocates all-object members under `allOf` beside a user `.meta({anyOf})`).
    // Every key uses EVERY-member semantics, preserving the pre-#2464 stamp/wrap
    // decision for untouched emissions (e.g. `z.intersection(z.object(...), z.any())`
    // stays typeless and 2025-era-wrapped); the loosen rewrite's relocated
    // `{anyOf: members}` conjunct is itself provably object-shaped, so its proof
    // survives the stricter rule.
    for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
        const members = schema[key];
        if (!Array.isArray(members) || members.length === 0) continue;
        if (members.every(member => isObjectMember(member))) return true;
    }
    return false;
}

// Validation

export type StandardSchemaValidationResult<T> = { success: true; data: T } | { success: false; error: string };

function formatIssue(issue: StandardSchemaV1.Issue): string {
    if (!issue.path?.length) return issue.message;
    const path = issue.path.map(p => String(typeof p === 'object' ? p.key : p)).join('.');
    return `${path}: ${issue.message}`;
}

export async function validateStandardSchema<T extends StandardSchemaV1>(
    schema: T,
    data: unknown
): Promise<StandardSchemaValidationResult<StandardSchemaV1.InferOutput<T>>> {
    const result = await schema['~standard'].validate(data);
    if (result.issues && result.issues.length > 0) {
        return { success: false, error: result.issues.map(i => formatIssue(i)).join(', ') };
    }
    return { success: true, data: (result as StandardSchemaV1.SuccessResult<unknown>).value as StandardSchemaV1.InferOutput<T> };
}

/*
 * Format-companion patterns: libraries realize a string `format` check as a companion
 * `pattern` regex, which the elicitation wire schema cannot carry. zod's are derived
 * from the resolved zod at runtime (never vendored — in-range releases change them), so
 * customized zod patterns are distinguishable and reject; other vendors' realizations
 * are unknowable (e.g. ArkType's `string.email`), so their patterns are trusted-and-dropped.
 */

function zodEmittedPattern(schema: z.ZodType): string | undefined {
    const jsonSchema = z.toJSONSchema(schema, { target: JSON_SCHEMA_CONVERSION_TARGET, io: 'input' }) as Record<string, unknown>;
    return typeof jsonSchema.pattern === 'string' ? jsonSchema.pattern : undefined;
}

const DATETIME_FRACTION_DIGITS = /\\\.\\d\{(\d+)\}/;

function datetimeReferenceSchemas(pattern: string): z.ZodType[] {
    // Options (offset/local/precision) vary the emission; recovering the fraction-digit
    // count keeps the candidate set finite.
    const fractionDigits = DATETIME_FRACTION_DIGITS.exec(pattern);
    const precisions: Array<number | undefined> = [undefined, -1, 0];
    if (fractionDigits) {
        precisions.push(Number(fractionDigits[1]));
    }
    return [false, true].flatMap(local =>
        [false, true].flatMap(offset => precisions.map(precision => z.iso.datetime({ local, offset, precision })))
    );
}

// Exhaustive over the wire's format enum: a new spec format is a compile error here.
function referencePatternsForFormat(format: NonNullable<StringSchema['format']>, pattern: string): ReadonlySet<string> {
    let referenceSchemas: z.ZodType[];
    switch (format) {
        case 'email': {
            referenceSchemas = [z.email()];
            break;
        }
        case 'uri': {
            referenceSchemas = [z.url()];
            break;
        }
        case 'date': {
            referenceSchemas = [z.iso.date()];
            break;
        }
        case 'date-time': {
            referenceSchemas = datetimeReferenceSchemas(pattern);
            break;
        }
    }
    return new Set(referenceSchemas.map(schema => zodEmittedPattern(schema)).filter((emitted): emitted is string => emitted !== undefined));
}

/** Whether `pattern` is the library's own realization of `format` (droppable) rather than a user customization. */
export function isLibraryFormatPattern(format: NonNullable<StringSchema['format']>, pattern: string, vendor: string): boolean {
    if (vendor !== 'zod') {
        return true;
    }
    return referencePatternsForFormat(format, pattern).has(pattern);
}

// Prompt argument extraction

export function promptArgumentsFromStandardSchema(
    schema: StandardJSONSchemaV1
): Array<{ name: string; description?: string; required: boolean }> {
    const jsonSchema = standardSchemaToJsonSchema(schema, 'input');
    const properties = (jsonSchema.properties as Record<string, { description?: string }>) || {};
    const required = (jsonSchema.required as string[]) || [];

    return Object.entries(properties).map(([name, prop]) => ({
        name,
        description: prop?.description,
        required: required.includes(name)
    }));
}
