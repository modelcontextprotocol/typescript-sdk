import type * as z from 'zod/v4';

import * as authSchemas from '../shared/auth.js';
import type { StandardSchemaV1 } from '../util/standardSchema.js';
import * as schemas from './schemas.js';

type SchemaModule = typeof schemas & typeof authSchemas;

type StripSchemaSuffix<K> = K extends `${infer N}Schema` ? N : never;

/** Keys of `schemas.ts` that end in `Schema` and hold a Standard Schema value. */
type SchemaKey = {
    [K in keyof SchemaModule]: K extends `${string}Schema`
        ? SchemaModule[K] extends { readonly '~standard': unknown }
            ? K
            : never
        : never;
}[keyof SchemaModule];

/**
 * Union of every named type in the SDK's protocol and OAuth schemas (e.g. `'CallToolResult'`,
 * `'ContentBlock'`, `'Tool'`, `'OAuthTokens'`). Derived from the internal Zod schemas, so it stays
 * in sync with the spec.
 */
export type SpecTypeName = StripSchemaSuffix<SchemaKey>;

/**
 * Maps each {@linkcode SpecTypeName} to its TypeScript type.
 *
 * `SpecTypes['CallToolResult']` is equivalent to importing the `CallToolResult` type directly.
 */
export type SpecTypes = {
    [K in SchemaKey as StripSchemaSuffix<K>]: SchemaModule[K] extends z.ZodType<infer T> ? T : never;
};

type SchemaRecord = { readonly [K in SpecTypeName]: StandardSchemaV1<SpecTypes[K]> };
type GuardRecord = { readonly [K in SpecTypeName]: (value: unknown) => value is SpecTypes[K] };

const _specTypeSchemas: Record<string, z.ZodTypeAny> = {};
const _isSpecType: Record<string, (value: unknown) => boolean> = {};
for (const source of [schemas, authSchemas]) {
    for (const [key, value] of Object.entries(source)) {
        if (key.endsWith('Schema') && value !== null && typeof value === 'object') {
            const name = key.slice(0, -'Schema'.length);
            const schema = value as z.ZodTypeAny;
            _specTypeSchemas[name] = schema;
            _isSpecType[name] = (v: unknown) => schema.safeParse(v).success;
        }
    }
}

/**
 * Runtime validators for every MCP spec type, keyed by type name.
 *
 * Use this when you need to validate a spec-defined shape at a boundary the SDK does not own, for
 * example an extension's custom-method payload that embeds a `CallToolResult`, or a value read from
 * storage that should be a `Tool`.
 *
 * Each entry implements the Standard Schema interface (`schema['~standard'].validate(value)`), so it
 * composes with any Standard-Schema-aware library.
 *
 * @example
 * ```ts
 * const result = specTypeSchemas.CallToolResult['~standard'].validate(untrusted);
 * if (result.issues === undefined) {
 *     // result.value is CallToolResult
 * }
 * ```
 */
export const specTypeSchemas: SchemaRecord = Object.freeze(_specTypeSchemas) as unknown as SchemaRecord;

/**
 * Type predicates for every MCP spec type, keyed by type name.
 *
 * Returns `true` if the value structurally matches the named spec type. Each guard is a standalone
 * function, so it can be passed directly as a callback.
 *
 * @example
 * ```ts
 * if (isSpecType.ContentBlock(value)) {
 *     // value is ContentBlock
 * }
 *
 * const blocks = mixed.filter(isSpecType.ContentBlock);
 * ```
 */
export const isSpecType: GuardRecord = Object.freeze(_isSpecType) as unknown as GuardRecord;
