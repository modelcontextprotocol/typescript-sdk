/**
 * Internal Zod schema utilities for protocol handling.
 * These are used internally by the SDK for protocol message validation.
 */

import * as z from 'zod/v4';

/**
 * Base type for any Zod schema.
 */
export type AnySchema = z.core.$ZodType;

/**
 * A Zod schema for objects specifically.
 */
export type AnyObjectSchema = z.core.$ZodObject;

/**
 * Extracts the output type from a Zod schema.
 */
export type SchemaOutput<T extends AnySchema> = z.output<T>;

/**
 * Parses data against a Zod schema (synchronous).
 * Returns a discriminated union with success/error.
 */
export function parseSchema<T extends AnySchema>(
    schema: T,
    data: unknown
): { success: true; data: z.output<T> } | { success: false; error: z.core.$ZodError } {
    return z.safeParse(schema, data);
}
