/**
 * Zod-specific helpers for the v1-compat raw-shape shorthand on
 * `registerTool`/`registerPrompt`. Kept separate from `standardSchema.ts` so
 * that file stays library-agnostic per the Standard Schema spec.
 */

import * as z from 'zod/v4';

import type { StandardSchemaWithJSON } from './standardSchema.js';
import { isStandardSchema, standardSchemaToJsonSchema } from './standardSchema.js';

function isZodV4Schema(v: unknown): v is z.ZodType {
    // `_zod` is the v4 internal namespace property. Zod v3 schemas have `_def`
    // and (since 3.24) `~standard.vendor === 'zod'`, but never `_zod`. We require
    // v4 because the wrap path below uses v4's `z.object()`, which cannot consume
    // v3 field schemas.
    return typeof v === 'object' && v !== null && '_zod' in v;
}

function looksLikeZodV3(v: unknown): boolean {
    // v3 schemas have `_def.typeName` (e.g. 'ZodString') and no `_zod`.
    return (
        typeof v === 'object' &&
        v !== null &&
        !('_zod' in v) &&
        '_def' in v &&
        typeof (v as { _def?: { typeName?: unknown } })._def?.typeName === 'string'
    );
}

/**
 * Detects a "raw shape" — a plain object whose values are Zod field schemas,
 * e.g. `{ name: z.string() }`. Powers the auto-wrap in
 * {@linkcode normalizeRawShapeSchema}, which wraps with `z.object()`, so only
 * Zod values are supported.
 *
 * @internal
 */
export function isZodRawShape(obj: unknown): obj is Record<string, z.ZodType> {
    if (typeof obj !== 'object' || obj === null) return false;
    if (isStandardSchema(obj)) return false;
    // Require a plain object literal: rejects arrays, Date, Map, RegExp, class instances, etc.
    // Object.create(null) is also accepted.
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) return false;
    // [].every() is true, so an empty plain object is a valid raw shape (matches v1).
    return Object.values(obj).every(v => isZodV4Schema(v));
}

/**
 * Accepts either a {@linkcode StandardSchemaWithJSON} or a raw Zod shape
 * `{ field: z.string() }` and returns a {@linkcode StandardSchemaWithJSON}.
 * Raw shapes are wrapped with `z.object()` so the rest of the pipeline sees a
 * uniform schema type; already-wrapped schemas pass through unchanged.
 *
 * @internal
 */
export function normalizeRawShapeSchema(
    schema: StandardSchemaWithJSON | Record<string, z.ZodType> | undefined,
    io: 'input' | 'output' = 'input'
): StandardSchemaWithJSON | undefined {
    if (schema === undefined) return undefined;
    if (isZodRawShape(schema)) {
        // Fail at registration time, not serve time. Listing handlers run this
        // exact JSON Schema conversion later; if the shape's field schemas come
        // from a different zod build than the one the SDK bundles (e.g. the
        // application's own zod 4.0/4.1 instance), the bundled converter can
        // fail while walking their internals. Without this check, a bad shape
        // registers fine and then crashes `tools/list` far from the cause.
        let wrapped: StandardSchemaWithJSON;
        try {
            wrapped = z.object(schema) as StandardSchemaWithJSON;
            standardSchemaToJsonSchema(wrapped, io);
        } catch (error) {
            throw new TypeError(
                'Raw-shape inputSchema/outputSchema/argsSchema could not be converted to JSON Schema. ' +
                    'The field schemas likely come from a different zod build than the one the SDK bundles. ' +
                    "Wrap the shape with your own zod's `z.object({...})` (zod >=4.2), or pass a JSON Schema via `fromJsonSchema()`.",
                { cause: error }
            );
        }
        return wrapped;
    }
    if (typeof schema === 'object' && schema !== null && !isStandardSchema(schema)) {
        const fields = Object.values(schema);
        const hasV3 = fields.some(v => looksLikeZodV3(v));
        if (hasV3 && fields.some(v => isZodV4Schema(v))) {
            // v1's zod-compat `objectFromShape` threw this exact error for
            // shapes mixing zod versions; keep the message byte-identical so
            // code and tests written against v1 keep matching.
            throw new Error('Mixed Zod versions detected in object shape.');
        }
        if (hasV3) {
            throw new TypeError(
                'Raw-shape inputSchema/outputSchema/argsSchema fields must be Zod v4 schemas. Got a Zod v3 field schema. Import from `zod/v4` (or upgrade your zod import), wrap with `z.object({...})` yourself, or pass a JSON Schema via `fromJsonSchema()`.'
            );
        }
    }
    if (!isStandardSchema(schema)) {
        throw new TypeError(
            'inputSchema/outputSchema/argsSchema must be a Standard Schema (e.g. z.object({...})) or a raw Zod shape ({ field: z.string() }).'
        );
    }
    // Any StandardSchema passes through; standardSchemaToJsonSchema owns the per-vendor
    // handling for schemas without `~standard.jsonSchema` (zod 4.0-4.1 fallback, zod 3
    // and non-zod errors). Gating on `~standard.jsonSchema` here would unreachably
    // front-run that fallback.
    return schema;
}
