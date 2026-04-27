/**
 * Zod-specific helpers for the v1-compat raw-shape shorthand on
 * `registerTool`/`registerPrompt`. Kept separate from `standardSchema.ts` so
 * that file stays library-agnostic per the Standard Schema spec.
 */

import * as z from 'zod/v4';

import type { StandardSchemaV1, StandardSchemaWithJSON } from './standardSchema.js';
import { isStandardSchema, isStandardSchemaWithJSON } from './standardSchema.js';

function isZodSchema(v: unknown): v is z.ZodType {
    if (typeof v !== 'object' || v === null) return false;
    if ('_def' in v) return true;
    return isStandardSchema(v) && (v as StandardSchemaV1)['~standard'].vendor === 'zod';
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
    // [].every() is true, so an empty object is a valid raw shape (matches v1).
    return Object.values(obj).every(v => isZodSchema(v));
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
    schema: StandardSchemaWithJSON | Record<string, z.ZodType> | undefined
): StandardSchemaWithJSON | undefined {
    if (schema === undefined) return undefined;
    if (isZodRawShape(schema)) {
        return z.object(schema) as StandardSchemaWithJSON;
    }
    if (!isStandardSchemaWithJSON(schema)) {
        throw new TypeError(
            'inputSchema/outputSchema/argsSchema must be a Standard Schema with JSON Schema export (`~standard.jsonSchema`, e.g. z.object({...}) from zod >=4.2.0) or a raw Zod shape ({ field: z.string() }).'
        );
    }
    return schema;
}
