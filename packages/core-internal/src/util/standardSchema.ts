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
 */
function zodConversionOptions(io: 'input' | 'output'): Pick<z.core.ToJSONSchemaParams, 'unrepresentable' | 'override'> {
    return {
        unrepresentable: 'any',
        override: ctx => {
            const def = ctx.zodSchema._zod.def;
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
                for (const key of Object.keys(ctx.jsonSchema)) {
                    // `x-*` vendor extensions are annotation-only (same convention as the
                    // elicitation walker) and carry no validation constraint.
                    if (ANNOTATION_JSON_SCHEMA_KEYWORDS.has(key) || key.startsWith('x-')) continue;
                    if (key === 'type' && ctx.jsonSchema.type === 'object') continue;
                    if ((key === 'anyOf' || key === 'oneOf' || key === 'allOf') && Array.isArray(ctx.jsonSchema[key])) {
                        ctx.jsonSchema[key] = (ctx.jsonSchema[key] as unknown[]).map(member => compositionTypeSkeleton(member));
                        continue;
                    }
                    delete ctx.jsonSchema[key];
                }
                return;
            }
            if (def.type === 'record') {
                // Enum-keyed records emit a `required` list too. Every key shares the one
                // value schema, so tolerance for missing keys is all-or-nothing.
                if (Array.isArray(ctx.jsonSchema.required) && fieldAcceptsMissingKey(def.valueType)) {
                    delete ctx.jsonSchema.required;
                }
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
                    if (filtered.length === 0) delete ctx.jsonSchema.required;
                    else ctx.jsonSchema.required = filtered;
                }
            }
        }
    };
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
    for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
        if (Array.isArray(source[key])) {
            skeleton[key] = (source[key] as unknown[]).map(member => compositionTypeSkeleton(member));
        }
    }
    return skeleton;
}

/**
 * JSON Schema annotation-vocabulary keywords (plus `default`, itself an annotation)
 * preserved when a node's constraints are degraded because validation does not enforce
 * them on the raw value (`.catch()` nodes).
 */
const ANNOTATION_JSON_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
    '$comment',
    'default',
    'deprecated',
    'description',
    'examples',
    'readOnly',
    'title',
    'writeOnly'
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
    // below to a Promise and wrongly keep the field required. The default may hide
    // inside a pipe's input side (`.default(7).transform(...)` is outer-`'pipe'`).
    if (hasStructuralDefault(field)) return true;
    // JSON.stringify drops Symbol- and function-valued keys from the serialized
    // payload entirely (the same mechanism that drops undefined-valued keys), so
    // such fields can never appear on the wire.
    const unwrapped = unwrappedZodDefType(field);
    if (unwrapped === 'symbol' || unwrapped === 'function') return true;
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
 * Whether the field's def chain carries a `default`/`prefault` node, unwinding pipe
 * INPUT sides, lazies, and transparent wrappers — so
 * `z.number().default(7).transform(async v => v)` (outer def `'pipe'`, the ZodDefault
 * at `def.in`) is recognized structurally. A missing key resolves against the pipe's
 * input side first, where the default fills before any later stage runs. `ancestors`
 * tracks the current traversal path so recursive lazies stay bounded.
 */
function hasStructuralDefault(field: unknown, ancestors: ReadonlySet<unknown> = new Set()): boolean {
    if (typeof field !== 'object' || field === null || ancestors.has(field)) return false;
    const def = (field as { _zod?: { def?: { type?: string; innerType?: unknown; getter?: unknown; in?: unknown } } })._zod?.def;
    if (def === undefined || typeof def.type !== 'string') return false;
    if (def.type === 'default' || def.type === 'prefault') return true;
    const path = new Set(ancestors);
    path.add(field);
    if (def.type === 'lazy' && typeof def.getter === 'function') {
        try {
            return hasStructuralDefault((def.getter as () => unknown)(), path);
        } catch {
            return false;
        }
    }
    if (def.type === 'pipe' && def.in !== undefined) {
        return hasStructuralDefault(def.in, path);
    }
    if (WRAPPER_ZOD_DEF_TYPES.has(def.type) && def.innerType !== undefined) {
        return hasStructuralDefault(def.innerType, path);
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
    const zodOptions = options?.unrepresentable === 'throw' ? undefined : zodConversionOptions(io);
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
        if (result.type !== undefined) return result;
        return isProvablyObjectShapedRoot(result) ? { type: 'object', ...result } : result;
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
        const nonObjectType = nonObjectTypelessRootType(schema);
        if (nonObjectType !== undefined) {
            throw new Error(
                `MCP tool and prompt schemas must describe objects (got a non-object ${nonObjectType} schema). ` +
                    `Wrap your schema in z.object({...}) or equivalent.`
            );
        }
    }
    return { type: 'object', ...result };
}

/**
 * The def type of a zod root that emits a typeless node yet provably cannot describe
 * an object, or `undefined` when the root may. Unwraps transparent wrappers, lazies,
 * and pipe input sides, then recurses into compositions: a union is non-object when
 * EVERY member is, an intersection when ANY side is (the value must satisfy both). A
 * member counts as non-object ONLY when it unwinds to a genuinely unrepresentable
 * type, or to a literal whose values are unrepresentable or mixed-type — representable
 * members (including single-type literals, zod's idiomatic enum spelling, and
 * representable non-object types like `z.string()`) keep the composition accepted,
 * exactly as such roots converted before #2464. `ancestors` tracks only the current
 * traversal path, so a shared instance gets a real verdict at every occurrence while
 * recursive lazies stay bounded.
 */
function nonObjectTypelessRootType(schema: unknown, ancestors: ReadonlySet<unknown> = new Set()): string | undefined {
    if (typeof schema !== 'object' || schema === null || ancestors.has(schema)) return undefined;
    const def = (
        schema as {
            _zod?: {
                def?: {
                    type?: string;
                    innerType?: unknown;
                    getter?: unknown;
                    in?: unknown;
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
            return nonObjectTypelessRootType((def.getter as () => unknown)(), path);
        } catch {
            return undefined;
        }
    }
    if (def.type === 'pipe' && def.in !== undefined) {
        return nonObjectTypelessRootType(def.in, path);
    }
    if (WRAPPER_ZOD_DEF_TYPES.has(def.type) && def.innerType !== undefined) {
        return nonObjectTypelessRootType(def.innerType, path);
    }
    if (def.type === 'union' && Array.isArray(def.options) && def.options.length > 0) {
        return def.options.every(option => nonObjectTypelessRootType(option, path) !== undefined) ? 'union' : undefined;
    }
    if (def.type === 'intersection' && def.left !== undefined && def.right !== undefined) {
        return nonObjectTypelessRootType(def.left, path) !== undefined || nonObjectTypelessRootType(def.right, path) !== undefined
            ? 'intersection'
            : undefined;
    }
    if (def.type === 'literal') {
        return isNonObjectTypelessLiteral(def.values) ? 'literal' : undefined;
    }
    return NON_OBJECT_UNREPRESENTABLE_TYPES.has(def.type) ? def.type : undefined;
}

/**
 * Whether a literal's values make its node both typeless and non-object: any
 * unrepresentable value (`undefined`, bigint, symbol) or a mixed-JSON-type value list.
 * Single-type representable literals emit an explicit `type` and may legitimately ride
 * compositions (`z.union([z.literal('admin'), z.literal('member')])`, zod's idiomatic
 * enum spelling, must keep listing exactly as it did pre-#2464).
 */
function isNonObjectTypelessLiteral(values: unknown): boolean {
    if (!Array.isArray(values) || values.length === 0) return true;
    const jsonTypes = new Set<string>();
    for (const value of values) {
        if (value === null) {
            jsonTypes.add('null');
            continue;
        }
        const valueType = typeof value;
        if (valueType !== 'string' && valueType !== 'number' && valueType !== 'boolean') {
            return true; // undefined / bigint / symbol values are unrepresentable
        }
        if (valueType === 'number' && !Number.isFinite(value as number)) {
            return true; // Infinity / -Infinity / NaN cannot ride JSON either
        }
        jsonTypes.add(valueType);
    }
    return jsonTypes.size > 1;
}

/**
 * Zod def types that are genuinely unrepresentable in JSON Schema and whose values can
 * never be a JSON object — the input-root guard must keep rejecting roots and
 * compositions built from them. Most degrade to a typeless `{}` under
 * `unrepresentable: 'any'`; `date` is instead rewritten to `string`/`date-time` (so a
 * bare date ROOT throws via the explicit-type guard), but a `Date` value can never be
 * a JSON object either, so date composition MEMBERS classify as non-object here.
 * `custom` and bare `transform` are deliberately excluded (they can legitimately
 * accept objects), and typeless literals are classified separately by value in
 * {@linkcode isNonObjectTypelessLiteral}.
 */
const NON_OBJECT_UNREPRESENTABLE_TYPES: ReadonlySet<string> = new Set([
    'bigint',
    'symbol',
    'map',
    'set',
    'void',
    'undefined',
    'nan',
    'function',
    'date'
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
 * The innermost def type of a zod schema, unwrapped through transparent wrappers
 * (`optional`/`nullable`/`readonly`/`default`/`prefault`/`catch`/`promise` via
 * `innerType`, `lazy` via its getter, and `pipe` via its INPUT side `def.in` — the
 * side `io: 'input'` conversion and input validation both consume) so
 * `z.bigint().optional()`, `z.lazy(() => z.bigint())`, and
 * `z.bigint().transform(...)` all report `'bigint'`. A seen-set bounds recursive
 * lazies; non-zod schemas and throwing lazy getters yield `undefined`.
 */
function unwrappedZodDefType(schema: unknown): string | undefined {
    const seen = new Set<unknown>();
    let current = schema;
    while (typeof current === 'object' && current !== null && !seen.has(current)) {
        seen.add(current);
        const def = (current as { _zod?: { def?: { type?: string; innerType?: unknown; getter?: unknown; in?: unknown } } })._zod?.def;
        if (def === undefined || typeof def.type !== 'string') return undefined;
        if (def.type === 'lazy' && typeof def.getter === 'function') {
            try {
                current = (def.getter as () => unknown)();
            } catch {
                return undefined;
            }
            continue;
        }
        if (def.type === 'pipe' && def.in !== undefined) {
            current = def.in;
            continue;
        }
        if (WRAPPER_ZOD_DEF_TYPES.has(def.type) && def.innerType !== undefined) {
            current = def.innerType;
            continue;
        }
        return def.type;
    }
    return undefined;
}

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
    for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
        const members = schema[key];
        if (Array.isArray(members) && members.length > 0) {
            return members.every(
                m =>
                    m !== null &&
                    typeof m === 'object' &&
                    ((m as Record<string, unknown>).type === 'object' || isProvablyObjectShapedRoot(m as Record<string, unknown>))
            );
        }
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
