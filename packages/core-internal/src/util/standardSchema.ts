/**
 * Standard Schema utilities for user-provided schemas.
 * Supports Zod v4, Valibot, ArkType, and other Standard Schema implementations.
 * @see https://standardschema.dev
 */

/* eslint-disable @typescript-eslint/no-namespace */

import * as z from 'zod/v4';

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
export function standardSchemaToJsonSchema(schema: StandardJSONSchemaV1, io: 'input' | 'output' = 'input'): Record<string, unknown> {
    const std = schema['~standard'];
    let result: Record<string, unknown>;
    if (std.jsonSchema) {
        result = std.jsonSchema[io]({ target: 'draft-2020-12' });
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
        result = z.toJSONSchema(schema as unknown as z.ZodType, { target: 'draft-2020-12', io }) as Record<string, unknown>;
        // zod 4.0–4.2 emits exhaustive records (z.record with enum/literal-union keys) without
        // `required`, although validation demands every key (fixed in zod 4.3, which never takes
        // this fallback). Patch the emission so advertised schemas match runtime validation.
        addRequiredToExhaustiveRecords(schema, result);
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
    return { type: 'object', ...result };
}

/** Structural view of a Zod v4 schema's `_zod` internals — only the fields the record fixup reads. */
interface ZodInternalsLike {
    def?: Record<string, unknown>;
    values?: unknown;
}

function zodInternalsOf(value: unknown): ZodInternalsLike | undefined {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return undefined;
    const internals = (value as { _zod?: unknown })._zod;
    return typeof internals === 'object' && internals !== null ? (internals as ZodInternalsLike) : undefined;
}

/**
 * Known emission gap in zod 4.0.x–4.2.x (fixed in 4.3): `z.toJSONSchema` converts
 * `z.record(z.enum(['a','b']), value)` to
 * `{type:'object', propertyNames:{enum:['a','b']}, additionalProperties:…}` with NO `required`,
 * although runtime validation rejects objects missing any key (exhaustive records). A tool
 * advertising that schema accepts inputs its own validation then refuses.
 *
 * `z.partialRecord` emits the *same* JSON shape but validates keys as optional, so the emitted
 * JSON alone cannot distinguish the two. This fixup therefore walks the ZOD schema for record
 * nodes whose key type carries a finite string key set (`keyType._zod.values` — the exact marker
 * zod's own record parser uses to decide exhaustiveness; `partialRecord` clears it), then adds
 * `required: [...keys]` to every emitted record-shaped JSON node whose `propertyNames` key set
 * matches one of those exhaustive sets. Nodes that already carry `required` are left untouched,
 * so the fixup is a no-op on zod versions that emit it themselves.
 *
 * Limitation: a partial record and an exhaustive record with the *identical* key set in the same
 * schema are indistinguishable in the emitted JSON, so the partial one would also gain `required`.
 * Affected users can upgrade to zod >=4.3, whose native emission never takes this fallback.
 */
export function addRequiredToExhaustiveRecords(schema: unknown, jsonSchema: Record<string, unknown>): void {
    const exhaustiveKeySets: Array<ReadonlySet<string>> = [];
    collectExhaustiveRecordKeySets(schema, exhaustiveKeySets, new Set());
    if (exhaustiveKeySets.length === 0) return;
    patchMatchingRecordNodes(jsonSchema, exhaustiveKeySets);
}

/** Walks a Zod schema tree, collecting the key set of every exhaustive (non-partial) record node. */
function collectExhaustiveRecordKeySets(schema: unknown, keySets: Array<ReadonlySet<string>>, seen: Set<object>): void {
    const internals = zodInternalsOf(schema);
    if (internals === undefined || seen.has(schema as object)) return;
    seen.add(schema as object);
    const def = internals.def;
    if (def === undefined || typeof def !== 'object') return;
    if (def.type === 'record') {
        const keyValues = zodInternalsOf(def.keyType)?.values;
        if (keyValues instanceof Set && keyValues.size > 0) {
            const keys = [...keyValues];
            if (keys.every((k): k is string => typeof k === 'string')) keySets.push(new Set(keys));
        }
    }
    if (def.type === 'lazy' && typeof def.getter === 'function') {
        try {
            collectExhaustiveRecordKeySets((def.getter as () => unknown)(), keySets, seen);
        } catch {
            // A throwing lazy getter means the subtree cannot be inspected; skip it.
        }
    }
    for (const value of Object.values(def)) {
        visitDefValue(value, keySets, seen);
    }
}

/** Recurses into def entries that hold child schemas: schemas, arrays of schemas, and shape objects. */
function visitDefValue(value: unknown, keySets: Array<ReadonlySet<string>>, seen: Set<object>): void {
    if (value === null || typeof value !== 'object') return;
    if (zodInternalsOf(value) !== undefined) {
        collectExhaustiveRecordKeySets(value, keySets, seen);
        return;
    }
    const children = Array.isArray(value) ? value : Object.values(value);
    for (const child of children) {
        if (zodInternalsOf(child) !== undefined) collectExhaustiveRecordKeySets(child, keySets, seen);
    }
}

/** Extracts the string key set from a record emission's `propertyNames` (enum, const, or const union). */
function keysFromPropertyNames(propertyNames: unknown): string[] | undefined {
    if (propertyNames === null || typeof propertyNames !== 'object') return undefined;
    const pn = propertyNames as Record<string, unknown>;
    if (Array.isArray(pn.enum)) {
        // Copy: the returned array is assigned to `required`, and must not alias `propertyNames.enum`.
        return pn.enum.every((k): k is string => typeof k === 'string') ? [...pn.enum] : undefined;
    }
    if (typeof pn.const === 'string') return [pn.const];
    for (const compositionKey of ['anyOf', 'oneOf'] as const) {
        const members = pn[compositionKey];
        if (Array.isArray(members) && members.length > 0) {
            const consts = members.map(m => (m !== null && typeof m === 'object' ? (m as Record<string, unknown>).const : undefined));
            if (consts.every((c): c is string => typeof c === 'string')) return consts;
        }
    }
    return undefined;
}

/** Adds `required` to emitted record nodes whose propertyNames key set matches an exhaustive record. */
function patchMatchingRecordNodes(node: unknown, keySets: ReadonlyArray<ReadonlySet<string>>): void {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
        for (const item of node) patchMatchingRecordNodes(item, keySets);
        return;
    }
    const obj = node as Record<string, unknown>;
    if (obj.required === undefined && obj.propertyNames !== undefined && (obj.type === 'object' || obj.type === undefined)) {
        const keys = keysFromPropertyNames(obj.propertyNames);
        if (keys !== undefined && keySets.some(set => set.size === keys.length && keys.every(k => set.has(k)))) {
            obj.required = keys;
        }
    }
    for (const value of Object.values(obj)) {
        patchMatchingRecordNodes(value, keySets);
    }
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
