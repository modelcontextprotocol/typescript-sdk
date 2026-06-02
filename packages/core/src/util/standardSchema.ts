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

function isZodFallbackWarningSuppressed(): boolean {
    // Core must stay runtime-neutral (browser / Workers), so reach for `process` defensively.
    try {
        const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
        const value = env?.MCP_SUPPRESS_ZOD_FALLBACK_WARNING;
        return value !== undefined && value !== '' && value !== '0' && value !== 'false';
    } catch {
        return false;
    }
}

function readForeignDescription(node: unknown): string | undefined {
    // `.description` is a getter that runs the schema's own zod code against its own
    // metadata registry, so it works across zod instances where the bundled converter
    // cannot. Foreign getters are untrusted: never let them break conversion.
    try {
        const description = (node as { description?: unknown }).description;
        return typeof description === 'string' && description.length > 0 ? description : undefined;
    } catch {
        return undefined;
    }
}

function unwrapForeignSchema(node: unknown): unknown {
    // Wrappers like .optional()/.nullable()/.default() carry their own registry entry;
    // a .describe() applied before wrapping lives on the inner schema instead.
    try {
        const def = (node as { _zod?: { def?: { innerType?: unknown } } })._zod?.def;
        return def?.innerType;
    } catch {
        return undefined;
    }
}

function readForeignDescriptionDeep(node: unknown): string | undefined {
    let current: unknown = node;
    for (let depth = 0; depth < 8 && current != null; depth++) {
        const description = readForeignDescription(current);
        if (description !== undefined) return description;
        current = unwrapForeignSchema(current);
    }
    return undefined;
}

function foreignShape(node: unknown): Record<string, unknown> | undefined {
    let current: unknown = node;
    for (let depth = 0; depth < 8 && current != null; depth++) {
        try {
            const shape = (current as { shape?: unknown }).shape;
            if (shape != null && typeof shape === 'object') return shape as Record<string, unknown>;
        } catch {
            return undefined;
        }
        current = unwrapForeignSchema(current);
    }
    return undefined;
}

function foreignElement(node: unknown): unknown {
    let current: unknown = node;
    for (let depth = 0; depth < 8 && current != null; depth++) {
        try {
            const element = (current as { element?: unknown }).element;
            if (element != null) return element;
        } catch {
            return undefined;
        }
        current = unwrapForeignSchema(current);
    }
    return undefined;
}

/**
 * Best-effort recovery of `.describe()` metadata after converting a foreign zod
 * instance's schema with the SDK-bundled `z.toJSONSchema()`.
 *
 * Zod stores `.describe()` text in a per-instance metadata registry, so the bundled
 * converter silently drops every description attached through a different zod instance
 * (zod 4.0/4.1, or the zod@3.25.x `zod/v4` subpath). The schema's own `.description`
 * getters still work, so walk the schema alongside the converted JSON Schema and fill
 * in any descriptions the converter missed. Existing descriptions are never overwritten.
 */
function recoverForeignDescriptions(
    schema: unknown,
    jsonSchema: Record<string, unknown>,
    visited = new WeakSet<object>(),
    depth = 0
): void {
    if (depth > 16 || schema == null || typeof schema !== 'object') return;
    if (visited.has(schema)) return;
    visited.add(schema);

    if (jsonSchema.description === undefined) {
        const description = readForeignDescriptionDeep(schema);
        if (description !== undefined) jsonSchema.description = description;
    }

    const properties = jsonSchema.properties;
    if (properties != null && typeof properties === 'object') {
        const shape = foreignShape(schema);
        if (shape) {
            for (const [key, fieldSchema] of Object.entries(shape)) {
                const fieldJson = (properties as Record<string, unknown>)[key];
                if (fieldJson != null && typeof fieldJson === 'object') {
                    recoverForeignDescriptions(fieldSchema, fieldJson as Record<string, unknown>, visited, depth + 1);
                }
            }
        }
    }

    const items = jsonSchema.items;
    if (items != null && typeof items === 'object' && !Array.isArray(items)) {
        const element = foreignElement(schema);
        if (element != null) {
            recoverForeignDescriptions(element, items as Record<string, unknown>, visited, depth + 1);
        }
    }
}

/**
 * Converts a StandardSchema to JSON Schema for use as an MCP tool/prompt schema.
 *
 * MCP requires `type: "object"` at the root of tool inputSchema/outputSchema and
 * prompt argument schemas. Zod's discriminated unions emit `{oneOf: [...]}` without
 * a top-level `type`, so this function defaults `type` to `"object"` when absent.
 *
 * Throws if the schema has an explicit non-object `type` (e.g. `z.string()`),
 * since that cannot satisfy the MCP spec.
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
        if (!warnedZodFallback && !isZodFallbackWarningSuppressed()) {
            warnedZodFallback = true;
            console.warn(
                '[mcp-sdk] Your zod version does not implement `~standard.jsonSchema` (added in zod 4.2.0). ' +
                    'Falling back to the bundled converter; `.describe()` descriptions are recovered on a best-effort ' +
                    'basis but other registry metadata (`.meta()`) may be lost. Upgrade to zod >=4.2.0 for full ' +
                    'fidelity, or set MCP_SUPPRESS_ZOD_FALLBACK_WARNING=1 to silence this warning.'
            );
        }
        result = z.toJSONSchema(schema as unknown as z.ZodType, { target: 'draft-2020-12', io }) as Record<string, unknown>;
        recoverForeignDescriptions(schema, result);
    } else {
        throw new Error(
            `Schema library "${std.vendor}" does not implement StandardJSONSchemaV1 (\`~standard.jsonSchema\`). ` +
                `Upgrade to a version that does, or wrap your JSON Schema with fromJsonSchema().`
        );
    }
    if (result.type !== undefined && result.type !== 'object') {
        throw new Error(
            `MCP tool and prompt schemas must describe objects (got type: ${JSON.stringify(result.type)}). ` +
                `Wrap your schema in z.object({...}) or equivalent.`
        );
    }
    return { type: 'object', ...result };
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
