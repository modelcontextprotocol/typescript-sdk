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

const specTypeSchemas: Record<string, z.ZodTypeAny> = {};
for (const source of [schemas, authSchemas]) {
    for (const [key, value] of Object.entries(source)) {
        if (key.endsWith('Schema') && value !== null && typeof value === 'object') {
            specTypeSchemas[key.slice(0, -'Schema'.length)] = value as z.ZodTypeAny;
        }
    }
}

/**
 * Returns a {@linkcode StandardSchemaV1} validator for the named MCP spec type.
 *
 * Use this when you need to validate a spec-defined shape at a boundary the SDK does not own —
 * for example, an extension's custom-method payload that embeds a `CallToolResult`, or a value
 * read from storage that should be a `Tool`.
 *
 * The returned object implements the Standard Schema interface
 * (`schema['~standard'].validate(value)`), so it composes with any Standard-Schema-aware library.
 *
 * @throws {TypeError} if `name` is not a known spec type.
 *
 * @example
 * ```ts
 * const schema = specTypeSchema('CallToolResult');
 * const result = schema['~standard'].validate(untrusted);
 * if (result.issues === undefined) {
 *     // result.value is CallToolResult
 * }
 * ```
 */
export function specTypeSchema<K extends SpecTypeName>(name: K): StandardSchemaV1<SpecTypes[K]> {
    const schema = specTypeSchemas[name];
    if (schema === undefined) {
        throw new TypeError(`Unknown MCP spec type: "${name}"`);
    }
    return schema as unknown as StandardSchemaV1<SpecTypes[K]>;
}

/**
 * Type predicate: returns `true` if `value` structurally matches the named MCP spec type.
 *
 * Convenience wrapper over {@linkcode specTypeSchema} for boolean checks.
 *
 * @example
 * ```ts
 * if (isSpecType('ContentBlock', value)) {
 *     // value is ContentBlock
 * }
 * ```
 */
export function isSpecType<K extends SpecTypeName>(name: K, value: unknown): value is SpecTypes[K] {
    return specTypeSchemas[name]?.safeParse(value).success ?? false;
}
