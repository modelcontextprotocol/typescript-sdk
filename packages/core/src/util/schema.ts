/**
 * Standard Schema utilities for protocol handling.
 * These are used internally by the SDK for protocol message validation.
 */

import type * as z from 'zod/v4';

import type { StandardSchemaV1 } from './standardSchema.js';
import { validateStandardSchema } from './standardSchema.js';

/**
 * Base type for any schema accepted by the SDK's user-facing schema parameters.
 *
 * This is the Standard Schema interface (https://standardschema.dev), which Zod, Valibot, ArkType
 * and others implement. Zod schemas satisfy this constraint natively.
 */
export type AnySchema = StandardSchemaV1;

/**
 * A Zod schema for objects specifically.
 *
 * Retained for internal use where the SDK needs Zod-specific introspection (e.g. converting a tool
 * input schema to JSON Schema). Not used for user-facing schema parameters.
 */
export type AnyObjectSchema = z.core.$ZodObject;

/**
 * Extracts the output type from a Standard Schema.
 */
export type SchemaOutput<T extends AnySchema> = StandardSchemaV1.InferOutput<T>;

/**
 * Parses data against a Standard Schema.
 *
 * Returns a discriminated union with success/error. The error is a plain `Error` whose `message`
 * is a comma-separated list of issues, so callers can interpolate it directly.
 */
export async function parseSchema<T extends AnySchema>(
    schema: T,
    data: unknown
): Promise<{ success: true; data: SchemaOutput<T> } | { success: false; error: Error }> {
    const result = await validateStandardSchema(schema, data);
    if (result.success) {
        return result;
    }
    return { success: false, error: new Error(result.error) };
}
