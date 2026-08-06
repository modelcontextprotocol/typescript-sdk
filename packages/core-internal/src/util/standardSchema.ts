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
 * - An undefined-unsafe `z.preprocess` fn wrapping a tolerant inner (`z.preprocess(
 *   v => (v as string).length, z.number().default(7))`) still advertises the field
 *   as droppable even though a missing key throws in the fn: the structural walk
 *   cannot evaluate the fn, and deferring the preprocess spelling to the
 *   validate(undefined) probe would mis-require async-refined preprocess fields
 *   (the probe goes async and conservatively claims nothing).
 * - The converse trade for async-staged VALIDATING pipe OUT sides: a genuinely
 *   tolerant `.default(5).pipe(z.number().min(1).refine(async () => true))` stays
 *   advertised as required — the probe goes async, and claiming IN-side tolerance
 *   structurally would wrongly drop `.default(0).pipe(z.number().min(1).refine(
 *   async …))`. The same trade applies to async CHECKS attached to the
 *   tolerance-granting node itself (`.default(0).refine(async () => true)`,
 *   `z.any().refine(async …)`): the check re-validates the fill, so no
 *   structural claim is sound and the async probe cannot decide. In both shapes
 *   the conservative stay-required posture (byte-parity with the pre-#2464
 *   emission) wins; async stages DOWNSTREAM of a check-free tolerant node
 *   (`.default(0).transform(async …)`) keep the structural drop.
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
 * - Hand-authored reference keywords disable the wire-truthfulness loosening
 *   entirely: when the emission carries any `$ref`/`$dynamicRef` beyond zod's own
 *   registry shapes (`#`, `#/$defs/<name>`), ANY ref — registry-shaped included —
 *   consumed under a `not`/`if`/`contains` polarity boundary, any
 *   `$anchor`/`$dynamicAnchor`, any `$id`, any `$recursiveRef`/`$recursiveAnchor`
 *   (2019-09 spellings the SDK's Ajv2020 engine still enforces), a non-root
 *   `$defs`, or any `unevaluatedProperties`/`unevaluatedItems` (annotation
 *   consumers that observe in-place loosening of their contributors as a
 *   tightening), the conversion ships the strict pre-#2464-shaped emission
 *   instead (see {@linkcode hasHandAuthoredReferenceConstructs}) — the loosen
 *   family relocates and deletes document positions, which such constructs
 *   observe as dangling pointers, stale anchors, shifted base-relative paths, or
 *   polarity-inverted/annotation-stripped tightenings. Those conversions keep
 *   pre-#2464 strictness (e.g. `additionalProperties: false` stays advertised,
 *   tolerant fields stay `required`), trading loosening for
 *   compilability-by-construction.
 * - The loosen rewrite's `oneOf` → `anyOf` rename skips lexical `not`/`if`/`contains`
 *   positions, but a `.meta({not: {oneOf: […]}})` cloning a positive-position
 *   composition observes the (legitimately) renamed sibling while keeping its own
 *   `oneOf` — the same composition cannot read `anyOf` for its positive consumer
 *   and `oneOf` for a negated clone, so cross-polarity duplication of loosened
 *   compositions stays untruthful (reference-keyword aliasing itself disables
 *   loosening per the previous bullet).
 */
function zodConversionOptions(
    io: 'input' | 'output',
    loosened: { value: boolean },
    loosen: boolean,
    stripLegacyId = true
): Pick<z.core.ToJSONSchemaParams, 'unrepresentable' | 'override'> {
    return {
        unrepresentable: 'any',
        override: ctx => {
            const def = ctx.zodSchema._zod.def;
            if (stripLegacyId && 'id' in ctx.jsonSchema) {
                // zod copies registry metadata (`.meta({id: 'X'})`) verbatim, emitting a
                // literal draft-04 `id` keyword that Ajv v8 hard-rejects at COMPILE time
                // ('NOT SUPPORTED: keyword "id", use "$id"' — strict: false does not
                // help), so the SDK's own client could never validate the advertisement.
                // Registry `$ref`s are path-based (#/$defs/Name) and cannot dangle;
                // renaming to `$id` would change base-URI resolution, so plain removal.
                // The strict and input passes DEFER this strip and apply it
                // post-hoc only when no hand-authored ref exists — refs beyond
                // zod's registry shapes may resolve through an `id` base on the
                // cfworker engine (see standardSchemaToJsonSchema). The loosen
                // pass strips in-hook: the guard already vouched the document
                // carries no hand-authored reference construct.
                delete ctx.jsonSchema.id;
            }
            if (def.type === 'date') {
                // Under `unrepresentable: 'any'` the node carries only user annotations
                // (`.describe()` / `.meta()`) — keep them and stamp the wire shape beside them.
                ctx.jsonSchema.type = 'string';
                ctx.jsonSchema.format = 'date-time';
                return;
            }
            // The loosen family below is gated twice: it rewrites only OUTPUT
            // advertisements, and only when the caller established (via the
            // strict detection pass) that no hand-authored reference construct
            // could observe the rewrites — see standardSchemaToJsonSchema.
            if (io !== 'output' || !loosen) return;
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
                        // Members reduce to skeletons UNDER THEIR EMITTED KEY. An
                        // exactly-one `oneOf` of indistinguishable skeletons would
                        // reject every payload, but the rename to the honest `anyOf`
                        // is DEFERRED to the epilogue's `rewriteOneOfToAnyOf` — it
                        // always runs once the degrade set `loosened`, keeping the
                        // rename logic in one place; no reference can observe the
                        // relocation, since any hand-authored ref disables the
                        // loosen family entirely (the reference guard vouched).
                        ctx.jsonSchema[key] = (ctx.jsonSchema[key] as unknown[]).map(member => compositionTypeSkeleton(member));
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
                // Tolerance uses the same predicate as the object required-filter
                // and record branches — structural walk PLUS the validate(undefined)
                // probe — so probe-only-tolerant elements (e.g. a z.preprocess whose
                // fn itself maps undefined to a value) get the wrap too.
                if (typeof items === 'object' && items !== null && !Array.isArray(items) && fieldAcceptsMissingKey(def.element)) {
                    loosened.value = true;
                    ctx.jsonSchema.items = { anyOf: [items, { type: 'null' }] };
                }
                return;
            }
            if (def.type === 'tuple') {
                // Same wire mechanism per prefix position. The wrap REASSIGNS a
                // fresh array on the node's top-level key — never writes into the
                // existing one: a `.meta({prefixItems})` array is the user's
                // registry-owned object (zod's Object.assign meta merge shares it
                // by reference, and this hook runs before the terminal deep
                // clone), so an in-place element write would permanently corrupt
                // registry metadata, nest one more anyOf per conversion, and leak
                // false null-tolerance into input advertisements.
                const prefixItems = ctx.jsonSchema.prefixItems;
                if (Array.isArray(def.items) && Array.isArray(prefixItems)) {
                    let wrappedAny = false;
                    const wrapped = prefixItems.map((emitted, index) => {
                        const item = index < (def.items as unknown[]).length ? (def.items as z.core.$ZodType[])[index] : undefined;
                        if (item !== undefined && typeof emitted === 'object' && emitted !== null && fieldAcceptsMissingKey(item)) {
                            wrappedAny = true;
                            return { anyOf: [emitted, { type: 'null' }] };
                        }
                        return emitted as unknown;
                    });
                    if (wrappedAny) {
                        loosened.value = true;
                        ctx.jsonSchema.prefixItems = wrapped as typeof ctx.jsonSchema.prefixItems;
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
                    fieldAcceptsMissingKey(def.rest ?? undefined)
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
                // A member-visible loosening like every other mutation here: two
                // registry-hoisted plain objects distinguished only by their extra
                // keys become mutually satisfiable, so a hand-authored exactly-one
                // `oneOf` over registry refs turns reject-everything unless the
                // epilogue rename fires — the flag must be set.
                loosened.value = true;
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
 * inverting exactly-one semantics into reject-everything. Also performs the
 * oneOf→anyOf renames the catch degrade deferred to keep the rename in one place.
 *
 * The rename relocates document positions, but no reference can observe it: the
 * loosen family runs only when {@linkcode hasHandAuthoredReferenceConstructs} found
 * none, and zod's own registry refs (`#`, `#/$defs/<name>`) never traverse a
 * `oneOf` segment.
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
            // No type stamp here: the relocation destroys evidence the 2025-era
            // wrap proof would read, so the epilogue decides the root stamp from
            // the STRICT pre-loosen snapshot instead (byte-parity with main), and
            // nested nodes never received any stamp pre-#2464.
            const allOf = Array.isArray(record.allOf) ? record.allOf : (record.allOf = []);
            allOf.push({ anyOf: record.oneOf });
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
        // the rewritten `not {anyOf}`), under `if` it can flip which then/else
        // branch applies, and under `contains` it raises the contains-count,
        // tightening against a sibling `maxContains` (zod never emits `contains`,
        // so skipping is regression-free).
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

/** The only `$ref` shape zod's emitter produces besides bare `#`: a top-level `$defs` entry. */
const ZOD_REGISTRY_REF_PATTERN = /^#\/\$defs\/[^/]+$/;

/**
 * Whether any reference keyword in the document carries a hand-authored value.
 * Hand-authored-ness is decided by value SHAPE and lexical CONTEXT together:
 * `#/$defs/<name>` root-base JSON Pointers are always zod-exempt — zod's own
 * emitter places them INSIDE draft-04 `id`-carrying entries too (recursive
 * z.lazy self-refs, cross-registered schemas), they resolve through the
 * document root rather than the `id` base, and stripping the `id` around them
 * is strictly safe on both engines (Ajv compiles; on cfworker the kept `id`
 * would make them dangle base-relatively). Bare `#` is exempt only OUTSIDE
 * `id` resources: inside one it addresses the resource base-relatively on the
 * cfworker engine, and zod never emits that spelling there — it is
 * hand-authored and observes the strip. `$recursiveRef` counts regardless of
 * value or position — zod never emits the keyword at all.
 */
function hasHandAuthoredRefValues(document: Record<string, unknown>): boolean {
    return someSchemaNode(document, (record, insideIdResource) =>
        ['$ref', '$dynamicRef', '$recursiveRef'].some(refKey => {
            const value = record[refKey];
            if (value === undefined) return false;
            if (refKey === '$recursiveRef') return true;
            if (typeof value !== 'string') return true;
            if (value === '#') return insideIdResource;
            return !ZOD_REGISTRY_REF_PATTERN.test(value);
        })
    );
}

/**
 * Deletes every keyword-position draft-04 `id` in the document — the post-hoc
 * spelling of the override hook's strip, for the conversion paths where the
 * override runs with the strip deferred. Only safe when
 * {@linkcode hasHandAuthoredRefValues} is false: with only zod-registry refs the
 * `id` keys are inert bases nothing resolves through, while Ajv v8 hard-rejects
 * the keyword at compile time. Any hand-authored ref — URI-form or
 * fragment-form — keeps the `id` (exact pre-#2464 parity: Ajv rejected those
 * documents then too, and the cfworker engine needs the base).
 */
function stripLegacyIdKeywords(document: Record<string, unknown>): void {
    someSchemaNode(document, record => {
        if ('id' in record) delete record.id;
        return false;
    });
}

/**
 * Position-aware some() over the document's schema nodes: only schema-carrying
 * keywords are descended into (data-valued `const`/`enum`/`default`/`examples`
 * and annotation values stay opaque), and schema-map VALUES are schemas while
 * their keys stay names — a property literally named `id` or `$ref` is user
 * data, not a keyword. The predicate also receives whether the node sits
 * lexically inside (or at) a draft-04 `id`-carrying resource, where ref
 * resolution is base-relative. Stops at the first node where `predicate`
 * returns true.
 */
function someSchemaNode(
    document: Record<string, unknown>,
    predicate: (record: Record<string, unknown>, insideIdResource: boolean) => boolean
): boolean {
    const walk = (node: unknown, seen: Set<unknown>, insideIdResource: boolean): boolean => {
        if (typeof node !== 'object' || node === null || seen.has(node)) return false;
        seen.add(node);
        if (Array.isArray(node)) return node.some(item => walk(item, seen, insideIdResource));
        const record = node as Record<string, unknown>;
        const inIdResource = insideIdResource || typeof record.id === 'string';
        if (predicate(record, inIdResource)) return true;
        for (const [key, value] of Object.entries(record)) {
            if (!SCHEMA_CARRYING_JSON_SCHEMA_KEYWORDS.has(key)) continue;
            if (SCHEMA_MAP_JSON_SCHEMA_KEYWORDS.has(key) && typeof value === 'object' && value !== null && !Array.isArray(value)) {
                if (seen.has(value)) continue;
                seen.add(value);
                for (const subschema of Object.values(value as Record<string, unknown>)) {
                    if (walk(subschema, seen, inIdResource)) return true;
                }
                continue;
            }
            if (walk(value, seen, inIdResource)) return true;
        }
        return false;
    };
    return walk(document, new Set(), false);
}

/**
 * Whether the emitted document carries any reference construct beyond what zod's
 * own emitter produces: a `$ref`/`$dynamicRef` that is not `#` or
 * `#/$defs/<name>` (the only shapes zod emits, for recursive, deduplicated, and
 * registered schemas), ANY ref — registry-shaped included — consumed under a
 * `not`/`if`/`contains` polarity boundary, any `$anchor`/`$dynamicAnchor`, any
 * `$id`, a `$defs` container anywhere but the conversion root, or any
 * `unevaluatedProperties`/`unevaluatedItems` (annotation consumers that observe
 * in-place loosening of their contributors as a tightening). All of these can
 * only enter an emission through `.meta()`/registry metadata — i.e. they are
 * hand-authored.
 *
 * The wire-truthfulness loosen family relocates and deletes document positions
 * (required-filter drops, catch degrades, null-tolerance element wraps, the
 * oneOf→anyOf rename), which hand-authored references observe as dangling
 * pointers, stale anchors, or shifted base-relative paths — an uncompilable or
 * silently tightened advertisement, strictly worse than pre-#2464 strictness.
 * Rather than repairing every reference form after the fact (pointer redirects,
 * anchor collection, embedded-`$id` sub-documents, RFC 3986 base resolution,
 * polarity-aware neutralization, …), a conversion carrying any such construct
 * SKIPS the loosen family and ships the strict pre-#2464-shaped emission:
 * compilable and working by construction. Registry refs are stable under every
 * loosen mutation — `$defs` stays at the conversion root (the catch degrade and
 * the constraint wrap both keep it), entry names are never touched, and entries
 * are only mutated in place — so registry-only documents loosen freely.
 *
 * Position-aware: only schema-carrying keywords are inspected (data-valued
 * `const`/`enum`/`default`/`examples` and annotation values may contain these key
 * names as plain user data), schema-map VALUES are schemas while their keys stay
 * names, and `not`/`if`/`contains` subtrees ARE inspected — their references
 * break all the same.
 */
function hasHandAuthoredReferenceConstructs(document: Record<string, unknown>): boolean {
    const walk = (
        node: unknown,
        isRoot: boolean,
        underPolarityBoundary: boolean,
        insideIdResource: boolean,
        seen: Set<unknown>
    ): boolean => {
        if (typeof node !== 'object' || node === null || seen.has(node)) return false;
        seen.add(node);
        if (Array.isArray(node)) return node.some(item => walk(item, false, underPolarityBoundary, insideIdResource, seen));
        const record = node as Record<string, unknown>;
        const inIdResource = insideIdResource || typeof record.id === 'string';
        for (const refKey of ['$ref', '$dynamicRef'] as const) {
            const value = record[refKey];
            if (value === undefined) continue;
            if (typeof value !== 'string') return true;
            // Registry refs are loosen-safe only for POSITIVE-polarity consumers:
            // the loosen family mutates `$defs` entries IN PLACE, so a consumer
            // reading the target under `not`/`if`/`contains` observes every
            // loosening as a tightening the rename walk's lexical polarity skip
            // cannot see through the ref indirection.
            if (underPolarityBoundary) return true;
            // Bare `#` is zod-exempt only OUTSIDE draft-04 `id` resources: the
            // cfworker engine resolves it base-relatively there, and zod never
            // emits that spelling inside an id-carrying entry — it is
            // hand-authored and observes the strip/loosening. `#/$defs/<name>`
            // pointers stay exempt everywhere: zod itself emits them inside id
            // entries (recursive/cross-registered schemas), and they resolve
            // through the document root.
            if (value === '#') {
                if (inIdResource) return true;
                continue;
            }
            if (!ZOD_REGISTRY_REF_PATTERN.test(value)) return true;
        }
        if (record.$anchor !== undefined || record.$dynamicAnchor !== undefined || record.$id !== undefined) return true;
        // 2019-09 recursion keywords: zod never emits them, and the SDK's
        // Ajv2020 engine enforces $recursiveRef in every draft mode — a negated
        // `{$recursiveRef: '#'}` observes root loosening as a tightening exactly
        // like its $dynamicRef successor (which the polarity clause catches).
        if (record.$recursiveRef !== undefined || record.$recursiveAnchor !== undefined) return true;
        if (!isRoot && record.$defs !== undefined) return true;
        // `unevaluatedProperties`/`unevaluatedItems` consume the 2020-12
        // evaluation annotations their sibling (and `$ref`-mediated) subschemas
        // contribute — in-place loosening of any contributor (a catch-degraded
        // union member, a loosened `$defs` target) silently strips annotations
        // and TIGHTENS the surviving consumer. zod never emits these keywords,
        // so their presence is hand-authored by definition.
        if (record.unevaluatedProperties !== undefined || record.unevaluatedItems !== undefined) return true;
        for (const [key, value] of Object.entries(record)) {
            if (!SCHEMA_CARRYING_JSON_SCHEMA_KEYWORDS.has(key)) continue;
            // Sticky through nesting: anything beneath a negative/conditional
            // keyword stays polarity-suspect (deeper `not`s only re-invert).
            const childUnderBoundary = underPolarityBoundary || key === 'not' || key === 'if' || key === 'contains';
            if (SCHEMA_MAP_JSON_SCHEMA_KEYWORDS.has(key) && typeof value === 'object' && value !== null && !Array.isArray(value)) {
                if (seen.has(value)) continue;
                seen.add(value);
                for (const subschema of Object.values(value as Record<string, unknown>)) {
                    if (walk(subschema, false, childUnderBoundary, inIdResource, seen)) return true;
                }
                continue;
            }
            if (walk(value, false, childUnderBoundary, inIdResource, seen)) return true;
        }
        return false;
    };
    return walk(document, true, false, false, new Set());
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
        // `$defs` constrains nothing and is PATH-addressed: inbound `#/…/$defs/X`
        // pointers spell out its exact position, so unlike the name-resolved
        // anchors (which relocate safely inside `anyOf[0]`) it must stay put.
        if (key === '$defs') continue;
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
    // Reference TARGETS constrain nothing — dropping them would dangle inbound
    // $refs. `$defs` rides along verbatim: its entries are path-addressed
    // (`#/…/$defs/X`), so unlike the name-resolved anchors they must stay at the
    // exact position inbound pointers spell out.
    for (const referenceKey of ['$anchor', '$dynamicAnchor', '$id', '$defs'] as const) {
        if (source[referenceKey] !== undefined) skeleton[referenceKey] = source[referenceKey];
    }
    for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
        if (Array.isArray(source[key])) {
            // Kept under the emitted key — including `oneOf`, whose skeletonized
            // members are indistinguishable and would reject every payload under
            // exactly-one semantics. The oneOf→anyOf rename is deferred to the
            // epilogue's `rewriteOneOfToAnyOf` (the degrade that skeletonizes
            // always sets `loosened`), keeping the rename in one place — safe
            // because the reference guard vouched no ref can observe it.
            skeleton[key] = (source[key] as unknown[]).map(member => compositionTypeSkeleton(member));
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
    // Draft-07 spelling of dependentSchemas (name→schema map; the
    // array-of-strings property-dependency form walks harmlessly) — Ajv2020
    // with strict:false still compiles and ENFORCES it, so the guard and the
    // rename walk must see inside.
    'dependencies',
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
    'unevaluatedItems',
    // Draft-07 tail-items spelling: the SDK's cfworker provider enforces it in
    // every draft mode (and collects refs inside it for resolution), so the
    // guard must walk inside — parallel to `dependencies` above.
    'additionalItems'
]);

/** Schema-map keywords among the above: their KEYS are user-chosen names, their values schemas. */
const SCHEMA_MAP_JSON_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
    'properties',
    'patternProperties',
    '$defs',
    'dependentSchemas',
    'dependencies'
]);

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
 * missing key as `undefined` — true for a check-free `.default()`, `z.any()`,
 * `z.unknown()`, `z.undefined()`, and unions with them; `.prefault()` and any
 * checks-carrying node re-validate the filled value, so the probe decides those),
 * so the wire schema must not advertise the field as `required`. A probe that
 * throws, rejects, or goes async (a `.transform()` choking on `undefined` does all
 * three depending on the zod version) cannot demonstrate tolerance, so such fields
 * conservatively stay required.
 */
function fieldAcceptsMissingKey(field: z.core.$ZodType | undefined): boolean {
    if (field === undefined) return false;
    // CHECK-FREE defaulted fields accept a missing key by construction (zod fills
    // the default; nothing re-validates it) — decide those structurally, since an
    // async DOWNSTREAM stage (`.transform(async ...)` after the default node)
    // would push the probe below to a Promise and wrongly keep the field
    // required. The walk also covers check-free static `.catch()` and
    // undefined-accepting leaves, Symbol-/function-typed fields (JSON.stringify
    // drops such keys entirely, checks or not), union members, and defaults
    // hidden inside a bare-transform pipe.
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
 * construction — a CHECK-FREE `default` (the default fills; `.prefault()`
 * re-validates the fill and defers to the probe), a check-free static `catch` (any
 * input, including `undefined`, is replaced by the fallback), `optional`, a
 * check-free undefined-accepting leaf (`z.any()`/`z.unknown()`/`z.undefined()`/
 * `z.void()`, or a literal whose values include `undefined`), or a
 * Symbol-/function-typed leaf (JSON.stringify drops such keys from the payload
 * entirely, checks or not) — unwinding bare-transform pipe sides, lazies,
 * transparent wrappers, and union members (ANY tolerant member suffices: zod
 * tries members and the tolerant one succeeds). Intersections claim tolerance
 * only for the provably-mergeable disjoint-key plain-object-defaults shape —
 * everything else defers to the probe. Deciding structurally matters
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
                    checks?: unknown;
                };
            };
        }
    )._zod?.def;
    if (def === undefined || typeof def.type !== 'string') return false;
    // Serialization-based tolerance first, checks or not: a symbol/function value
    // that PASSES its checks still never reaches the wire (JSON.stringify drops
    // the key).
    if (def.type === 'symbol' || def.type === 'function') return true;
    // A `.refine()`/`.check()` attaches to the SAME node (`def.checks`) and
    // re-validates the filled/accepted/passed-through value —
    // `.default(0).refine(v => v >= 1)` rejects a missing key — so NO
    // acceptance-based structural claim below is sound on a checks-carrying node:
    // defer to the validate(undefined) probe (sync verdicts are correct both
    // ways; async checks conservatively keep the field required, the documented
    // posture — see the async bullets in the Known residual gaps list).
    if (Array.isArray(def.checks) && def.checks.length > 0) return false;
    // `catch` and `optional` must be recognized BEFORE the wrapper unwind below
    // would step past the very node granting tolerance (bare `.optional()` fields
    // are already excluded from `required` by zod's emitter, but one inside a pipe
    // — `z.string().optional().transform(async ...)` — is not).
    if (def.type === 'default' || def.type === 'catch' || def.type === 'optional') return true;
    if (def.type === 'prefault') {
        // UNLIKE `.default()`, `.prefault(v)` feeds v THROUGH the inner schema —
        // `z.number().min(1).prefault(0)` rejects a missing key. Filling-then-
        // revalidating is not filling: claim nothing and let the probe decide
        // (sync verdicts are correct both ways; an async-refined valid-prefault
        // field conservatively stays required, matching the documented posture).
        return false;
    }
    if (def.type === 'any' || def.type === 'unknown' || def.type === 'undefined' || def.type === 'void') return true;
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
        const inDef = (def.in as { _zod?: { def?: { type?: string } } })._zod?.def;
        const outDef = (def.out as { _zod?: { def?: { type?: string } } } | undefined)?._zod?.def;
        // IN-side tolerance survives the pipe only when the OUT side is a BARE
        // TRANSFORM (nothing re-validates the filled/passed value — the pinned
        // `.default(7).transform(async …)` shape, where the async stage is exactly
        // why the probe cannot be used). A validating OUT side may reject the
        // filled value (`.default(0).pipe(z.number().min(1))` rejects 0;
        // `.optional().pipe(z.coerce.number())` coerces undefined to NaN), so the
        // walk claims nothing there and the validate(undefined) probe decides.
        if (outDef?.type === 'transform' && hasStructuralMissingKeyTolerance(def.in, path)) return true;
        // `z.preprocess(fn, inner)` builds the opposite pipe — the transform sits at
        // `def.in` and the tolerant node (e.g. a default) at `def.out`. The fn's
        // own undefined-safety is NOT checked (a Known residual gap): deferring to
        // the probe would mis-require async-refined preprocess fields the pinned
        // tests keep droppable.
        if (inDef?.type === 'transform' && def.out !== undefined) {
            return hasStructuralMissingKeyTolerance(def.out, path);
        }
        return false;
    }
    if (def.type === 'union' && Array.isArray(def.options)) {
        return def.options.some(option => hasStructuralMissingKeyTolerance(option, path));
    }
    if (def.type === 'intersection' && def.left !== undefined && def.right !== undefined) {
        // `undefined` must parse through BOTH sides AND the two filled results
        // must MERGE — zod throws 'Unmergable intersection' otherwise (two scalar
        // defaults with different values reject every payload omitting the key).
        // Merging is provable structurally only for the distinct-key
        // plain-object-defaults shape (the pinned async-refined spelling, where
        // the probe cannot be used); everything else defers to the probe.
        return intersectionSidesFillDisjointObjects(def.left, def.right);
    }
    if (def.type === 'promise') {
        // zod 4's promise parse rejects `undefined` outright regardless of the
        // inner type — there is no undefined-tolerant z.promise spelling. Claim
        // nothing (the generic unwind below would wrongly grant the inner's
        // tolerance); `promise` stays in WRAPPER_ZOD_DEF_TYPES for the
        // root-TYPE-verdict walks, where transparency is correct.
        return false;
    }
    if (def.type === 'nonoptional') {
        // z.nonoptional() RE-FORBIDS undefined, so tolerance by ACCEPTANCE inside
        // it (an inner optional, any/unknown, undefined-valued literals) does NOT
        // survive the wrapper — only tolerance by FILLING does (default/static
        // catch replace undefined before nonoptional's check runs). The
        // structural walk cannot tell the two apart, so it claims nothing and the
        // validate(undefined) probe in fieldAcceptsMissingKey decides: it returns
        // issues for `.optional().nonoptional()` (stays required) and success for
        // `.default(1).nonoptional()` (stays droppable). The generic unwind below
        // would wrongly propagate acceptance-tolerance through the re-forbid.
        // SERIALIZATION-drop tolerance is the exception: a symbol/function leaf
        // can never appear on the wire (JSON.stringify drops the key) no matter
        // what validation demands, and the probe cannot see that — it survives
        // the re-forbid.
        return hasSerializationDroppedLeaf(def.innerType);
    }
    if (WRAPPER_ZOD_DEF_TYPES.has(def.type) && def.innerType !== undefined) {
        return hasStructuralMissingKeyTolerance(def.innerType, path);
    }
    return false;
}

/**
 * Whether the field unwinds (through transparent wrappers) to a symbol- or
 * function-typed leaf — values `JSON.stringify` drops from the payload entirely,
 * so the key can never appear on the wire regardless of what validation demands.
 * Used where VALIDATION-based tolerance must not propagate but
 * SERIALIZATION-based tolerance still applies (the `nonoptional` re-forbid).
 */
function hasSerializationDroppedLeaf(field: unknown, ancestors: ReadonlySet<unknown> = new Set()): boolean {
    if (typeof field !== 'object' || field === null || ancestors.has(field)) return false;
    const def = (field as { _zod?: { def?: { type?: string; innerType?: unknown; getter?: unknown; options?: unknown } } })._zod?.def;
    if (def === undefined || typeof def.type !== 'string') return false;
    if (def.type === 'symbol' || def.type === 'function') return true;
    const path = new Set(ancestors);
    path.add(field);
    // Mirror the main walk's coverage: ANY-member union semantics (whenever the
    // symbol member is the matched one, the key vanishes from the wire) and
    // lazy-getter following with the same cycle bound.
    if (def.type === 'union' && Array.isArray(def.options)) {
        return def.options.some(option => hasSerializationDroppedLeaf(option, path));
    }
    if (def.type === 'lazy' && typeof def.getter === 'function') {
        try {
            return hasSerializationDroppedLeaf((def.getter as () => unknown)(), path);
        } catch {
            return false;
        }
    }
    if (WRAPPER_ZOD_DEF_TYPES.has(def.type) && def.innerType !== undefined) return hasSerializationDroppedLeaf(def.innerType, path);
    return false;
}

/**
 * The one structurally-provable mergeable-intersection shape: BOTH sides are
 * `.default()`s whose fill values are plain objects with disjoint key sets, so
 * zod's merge of the two fills cannot throw. Function-form defaults
 * (`.default(() => …)`) and every other spelling defer to the probe.
 */
function intersectionSidesFillDisjointObjects(left: unknown, right: unknown): boolean {
    const leftFill = plainObjectDefaultFill(left);
    if (leftFill === undefined) return false;
    const rightFill = plainObjectDefaultFill(right);
    if (rightFill === undefined) return false;
    return Object.keys(leftFill).every(key => !Object.hasOwn(rightFill, key));
}

/** The side's `.default()` fill value, when it is a plain (non-array) object. */
function plainObjectDefaultFill(side: unknown): Record<string, unknown> | undefined {
    if (typeof side !== 'object' || side === null) return undefined;
    const def = (side as { _zod?: { def?: { type?: string; defaultValue?: unknown } } })._zod?.def;
    if (def?.type !== 'default') return undefined;
    const fill = def.defaultValue;
    if (typeof fill !== 'object' || fill === null || Array.isArray(fill)) return undefined;
    // Mirror zod's own isPlainObject gate in mergeValues: Dates, Maps, and class
    // instances have zero own enumerable keys (vacuously "disjoint") yet zod
    // throws 'Unmergable intersection' on them unless the values are equal —
    // undecidable structurally, so the probe decides (correct both directions:
    // distinct-timestamp Date fills stay required, same-timestamp ones drop).
    const proto: unknown = Object.getPrototypeOf(fill);
    if (proto !== Object.prototype && proto !== null) return undefined;
    return fill as Record<string, unknown>;
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
    const convert = (zodOptions: Pick<z.core.ToJSONSchemaParams, 'unrepresentable' | 'override'> | undefined): Record<string, unknown> => {
        if (std.jsonSchema) {
            return std.jsonSchema[io]({
                target: JSON_SCHEMA_CONVERSION_TARGET,
                // Non-zod vendors receive no libraryOptions, so their behavior is unchanged.
                libraryOptions: std.vendor === 'zod' ? zodOptions : undefined
            });
        }
        if (std.vendor === 'zod') {
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
            return z.toJSONSchema(schema as unknown as z.ZodType, {
                target: JSON_SCHEMA_CONVERSION_TARGET,
                io,
                ...zodOptions
            }) as Record<string, unknown>;
        }
        throw new Error(
            `Schema library "${std.vendor}" does not implement StandardJSONSchemaV1 (\`~standard.jsonSchema\`). ` +
                `Upgrade to a version that does, or wrap your JSON Schema with fromJsonSchema().`
        );
    };
    let result: Record<string, unknown>;
    let strictRootProven: boolean | undefined;
    if (options?.unrepresentable === 'throw') {
        result = convert(undefined);
    } else if (io !== 'output' || std.vendor !== 'zod') {
        // The loosen family rewrites only zod OUTPUT advertisements — every other
        // conversion runs once, with the sanitizing overrides alone for zod
        // inputs. The draft-04 `id` strip is deferred and applied post-hoc under
        // the same hand-authored-ref gate as the output paths: an input document
        // whose refs resolve through an `id` base must keep it for the cfworker
        // engine.
        result = convert(zodConversionOptions(io, loosened, false, false));
        if (std.vendor === 'zod' && !hasHandAuthoredRefValues(result)) stripLegacyIdKeywords(result);
    } else {
        // Wire-truthfulness loosening is guarded by reference-construct detection:
        // first emit STRICTLY (sanitizing overrides only) and inspect the natural
        // document — the authoritative view of everything the user authored,
        // including constructs a loosen pass would itself delete. Hand-authored
        // reference keywords ship that strict, pre-#2464-shaped emission
        // (compilable and working by construction — see
        // `hasHandAuthoredReferenceConstructs`); reference-free documents (and
        // zod's own registry refs, stable under every mutation) convert again with
        // the loosen family active.
        // The strict pass defers the draft-04 `id` strip: when the guard fires,
        // the emission ships verbatim, and a URI-form hand-authored ref (itself a
        // guard trigger) may resolve through an `id` base on the cfworker engine
        // — stripping would break a working pre-#2464 registration.
        const strict = convert(zodConversionOptions(io, loosened, false, false));
        if (hasHandAuthoredReferenceConstructs(strict)) {
            // With only zod-registry refs the `id` keys are inert bases — strip
            // them post-hoc so Ajv keeps compiling registry-id documents (its v8
            // engine hard-rejects the keyword). ANY hand-authored ref keeps the
            // `id`: URI-form refs resolve through it, and even a fragment pointer
            // inside an `id` resource resolves relative to that base on the
            // cfworker engine (Ajv rejected such documents pre-#2464 too, so
            // keeping `id` is pre-fix parity).
            if (!hasHandAuthoredRefValues(strict)) stripLegacyIdKeywords(strict);
            result = strict;
        } else {
            // The 2025-era wrap-stamp decision must match main, which read the RAW
            // emission in ITS decision order: an explicit root `type` short-circuited
            // before the object proof ever ran (`{type: 'number',
            // properties: …}` stayed a wrapped non-object root — the proof's
            // keyword-presence rule never saw it), and only typeless roots were
            // proven. Loosen mutations can destroy proof-relevant keys (the
            // allOf-push relocates a root `oneOf`; the catch degrade deletes
            // meta-authored `required`/`properties` and non-object `type`s) or
            // expose ones main never read — flipping the SEP-2106 legacy wrap
            // either direction on an unrelated trigger. Snapshot the decision on
            // the strict emission; the output epilogue consults it instead of the
            // post-loosen document.
            strictRootProven = strict.type === undefined ? isProvablyObjectShapedRoot(strict) : strict.type === 'object';
            result = convert(zodConversionOptions(io, loosened, true));
        }
    }
    if (io === 'output' && loosened.value) {
        // Exactly-one semantics cannot survive member loosening: once ANY loosen
        // mutation fired anywhere in this conversion — a catch degrade, the
        // required-filter, or the additionalProperties drop — `oneOf` members
        // (zod's discriminated-union emission, or a hand-authored oneOf over
        // registry refs) may have become mutually satisfiable, and Ajv would
        // reject every payload with "must match exactly one schema in oneOf".
        // Rewrite to the honest `anyOf` (loosen-only; wrap-neutral because the
        // 2025-era stamp decision reads the strict pre-loosen snapshot; no
        // reference can observe the rename — the guard above vouched for it).
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
        // conjunct could prove the root. When a loosen pass ran, the proof reads the
        // STRICT pre-loosen snapshot — byte-parity with main, immune to loosen
        // mutations of proof-relevant keys; otherwise (guard-shipped strict result,
        // non-zod vendors) the document itself is the un-mutated emission.
        if (strictRootProven ?? isProvablyObjectShapedRoot(result)) return { type: 'object', ...result };
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
 *
 * `atIntersection` threads intersection context through the recursion: an
 * intersection value must satisfy BOTH sides, so a date member reached anywhere
 * under an intersection side — however deeply nested in unions/wrappers/pipes —
 * turns that side loud on the output path (every date-containing intersection
 * threw pre-#2464), while the same date stays quiet as a root or plain union
 * member (the date override makes those emissions wire-truthful). The
 * may-be-object bail keeps this satisfiability-aware: a union with an
 * `undefined`-verdict member (e.g. `z.union([z.date(), z.object({…})])`) may be
 * satisfiable against an object conjunct and stays accepted.
 */
function nonObjectTypelessRootVerdict(
    schema: unknown,
    io: 'input' | 'output',
    ancestors: ReadonlySet<unknown> = new Set(),
    atIntersection = false
): { type: string; loud: boolean; loudInside?: boolean } | undefined {
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
            return nonObjectTypelessRootVerdict((def.getter as () => unknown)(), io, path, atIntersection);
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
            const verdict = nonObjectTypelessRootVerdict(primary, io, path, atIntersection);
            if (verdict !== undefined) return verdict;
            // A bare transform on the processed side has no verdict of its own — the
            // real schema sits on the other side (`z.preprocess(fn, inner)` on input;
            // on output, zod threw 'Transforms cannot be represented' pre-#2464, so
            // consulting `def.in` keeps genuinely-unrepresentable inputs loud while
            // representable ones degrade gracefully).
            const primaryDef = (primary as { _zod?: { def?: { type?: string } } })._zod?.def;
            if (primaryDef?.type === 'transform' && secondary !== undefined) {
                return nonObjectTypelessRootVerdict(secondary, io, path, atIntersection);
            }
        }
        return undefined;
    }
    if (WRAPPER_ZOD_DEF_TYPES.has(def.type) && def.innerType !== undefined) {
        return nonObjectTypelessRootVerdict(def.innerType, io, path, atIntersection);
    }
    if (def.type === 'union' && Array.isArray(def.options) && def.options.length > 0) {
        const verdicts = def.options.map(option => nonObjectTypelessRootVerdict(option, io, path, atIntersection));
        // A may-be-object member (z.object, z.any, z.custom, … — `undefined`
        // verdicts — or a nested may-be-object composition) can make the union
        // satisfiable in ANY position, so the union reports the quiet
        // 'mayBeObject' verdict — but it CARRIES the members' inner loudness:
        // an intersection sibling that is provably non-object kills the object
        // possibility, and only then does the inner loudness surface
        // (`z.union([z.date(), z.object({…})])` against an OBJECT conjunct keeps
        // listing; against an ARRAY conjunct it threw pre-#2464 and keeps
        // throwing). Representable non-object members return DEFINED quiet
        // verdicts and do not trigger this branch.
        if (verdicts.includes(undefined) || verdicts.some(verdict => verdict?.type === 'mayBeObject')) {
            const loudInside = verdicts.some(verdict => verdict !== undefined && (verdict.loud || verdict.loudInside === true));
            return { type: 'mayBeObject', loud: false, loudInside };
        }
        const satisfiable = verdicts.some(verdict => verdict?.type === 'representable');
        // Union semantics discharge loudness OUTSIDE intersections: one
        // representable member makes the whole union a working schema
        // (`z.union([z.date(), z.string()])` accepts strings on input — the date
        // member is redundant, not fatal), preserving the established
        // representable-member-keeps-the-composition-accepted policy. AT an
        // intersection nothing representable can satisfy the object conjunct, so
        // a loud member's verdict stands.
        const loud = verdicts.some(verdict => verdict?.loud === true) && (atIntersection || !satisfiable);
        // A satisfiable union is itself representable-satisfiable for OUTER
        // compositions (`z.union([z.date(), z.union([z.string(), z.number()])])`
        // must discharge exactly like its flattened spelling).
        return { type: satisfiable ? 'representable' : 'union', loud };
    }
    if (def.type === 'intersection' && def.left !== undefined && def.right !== undefined) {
        // Sides recurse in intersection context: the value must satisfy BOTH
        // sides, so a date reached anywhere under either side (directly, or nested
        // in unions whose every co-member is provably non-object) is fatal on the
        // output path and reports loud from the date leaf itself.
        const left = nonObjectTypelessRootVerdict(def.left, io, path, true);
        const right = nonObjectTypelessRootVerdict(def.right, io, path, true);
        const leftMayBeObject = left === undefined || left.type === 'mayBeObject';
        const rightMayBeObject = right === undefined || right.type === 'mayBeObject';
        if (leftMayBeObject && rightMayBeObject) {
            if (left === undefined && right === undefined) return undefined;
            // Both sides may be object, so the intersection may be satisfiable —
            // quiet here, but the inner loudness rides along for an OUTER
            // provably-non-object conjunct to surface.
            return {
                type: 'mayBeObject',
                loud: false,
                loudInside: left?.loudInside === true || right?.loudInside === true
            };
        }
        if (leftMayBeObject || rightMayBeObject) {
            // One side is provably non-object: the other side's object possibility
            // is dead — no value satisfies both — so its carried inner loudness
            // surfaces (`z.intersection(z.array(…), z.union([z.date(), z.object(…)]))`
            // threw pre-#2464).
            const provablyNonObject = leftMayBeObject ? right! : left!;
            const mayBeObject = leftMayBeObject ? left : right;
            return { type: 'intersection', loud: provablyNonObject.loud || mayBeObject?.loudInside === true };
        }
        return { type: 'intersection', loud: left!.loud || right!.loud };
    }
    if (def.type === 'literal') {
        // The verdict stays DEFINED whatever the values: literal values are
        // primitives, so the node can never satisfy an object conjunct. A
        // representable value (string/finite number/boolean/null) wins over quiet
        // ones and marks the literal satisfiable.
        const loudness = nonObjectLiteralLoudness(def.values);
        if (loudness === undefined) return { type: 'representable', loud: false };
        return { type: 'literal', loud: loudness === 'loud' };
    }
    if (def.type === 'date') {
        // The date override rewrites every date node to its true wire form
        // (string/date-time), so a date-rooted OUTPUT emission is wire-truthful and
        // must keep listing (`z.date().nullable()` is a working 'timestamp or null'
        // tool); on INPUT no JSON payload satisfies raw z.date() validation, and at
        // an intersection no value satisfies both a Date side and the other side —
        // every date-containing intersection threw pre-#2464, so parity keeps
        // those loud.
        return { type: 'date', loud: io === 'input' || atIntersection };
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
    if (REPRESENTABLE_NON_OBJECT_ZOD_DEF_TYPES.has(def.type)) {
        // Representable and provably non-object: quiet in every position (these
        // all converted and listed pre-#2464), but DEFINED — unlike the
        // may-be-object `undefined` verdict — so a union pairing one with a date
        // cannot launder the intersection date-parity rule through the bail above
        // (`z.union([z.date(), z.string()])` against an object conjunct admits no
        // satisfying value and threw pre-#2464).
        return { type: 'representable', loud: false };
    }
    return NON_OBJECT_UNREPRESENTABLE_TYPES.has(def.type) ? { type: def.type, loud: true } : undefined;
}

/**
 * Zod def types that always emit a representable NON-OBJECT JSON type. Their
 * verdicts are quiet but DEFINED: `undefined` is reserved for may-be-object
 * shapes (`z.object`, `z.any`, `z.custom`, unrecognized defs), which is what the
 * union bail keys on to keep possibly-satisfiable intersections listing.
 */
const REPRESENTABLE_NON_OBJECT_ZOD_DEF_TYPES: ReadonlySet<string> = new Set([
    'string',
    'number',
    'boolean',
    'null',
    'enum',
    'template_literal',
    // A JSON array is never a JSON object (z.object rejects arrays at parse
    // time), so array/tuple members are provably non-object exactly like the
    // primitive types above.
    'array',
    'tuple'
]);

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
    // FIRST-PRESENT-KEY-WINS with EVERY-member semantics, matching the pre-#2464
    // stamp/wrap decision for untouched emissions: a multi-key root whose first
    // present composition key has a non-object member (e.g. an anyOf-emitting
    // nullable union carrying a user `.meta({allOf: [{type: 'object'}]})`) stayed
    // typeless and 2025-era-wrapped on main, so a later key must not prove what
    // the first cannot. The loosen rewrite's allOf-push does not rely on this
    // proof seeing its relocated conjunct: the output epilogue decides the root
    // stamp from the STRICT pre-loosen snapshot, where the emitted oneOf is
    // still the first present key.
    for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
        const members = schema[key];
        if (!Array.isArray(members) || members.length === 0) continue;
        return members.every(member => isObjectMember(member));
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
