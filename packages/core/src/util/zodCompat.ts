// zod-compat.ts
// ----------------------------------------------------
// Types + helpers for Zod v4 schemas
// ----------------------------------------------------

import type * as z4 from 'zod/v4/core';
import * as z4mini from 'zod/v4-mini';

// --- Schema types ---
export type AnySchema = z4.$ZodType;
export type AnyObjectSchema = z4.$ZodObject | AnySchema;
export type ZodRawShapeCompat = Record<string, AnySchema>;

// --- Type inference helpers ---
// Use direct indexed access for better generic type inference
// This avoids the conditional type in z4.output which resolves to unknown for generic S
export type SchemaOutput<S extends AnySchema> = S['_zod']['output'];
export type SchemaInput<S extends AnySchema> = S['_zod']['input'];

/**
 * Infers the output type from a ZodRawShapeCompat (raw shape object).
 * Maps over each key in the shape and infers the output type from each schema.
 */
export type ShapeOutput<Shape extends ZodRawShapeCompat> = {
    [K in keyof Shape]: SchemaOutput<Shape[K]>;
};

// --- Schema construction ---
export function objectFromShape(shape: ZodRawShapeCompat): AnyObjectSchema {
    return z4mini.object(shape as Record<string, z4.$ZodType>);
}

// --- Unified parsing ---
export function safeParse<S extends AnySchema>(
    schema: S,
    data: unknown
): { success: true; data: SchemaOutput<S> } | { success: false; error: unknown } {
    const s = schema as unknown as { safeParse(data: unknown): unknown };
    return s.safeParse(data) as { success: true; data: SchemaOutput<S> } | { success: false; error: unknown };
}

export async function safeParseAsync<S extends AnySchema>(
    schema: S,
    data: unknown
): Promise<{ success: true; data: SchemaOutput<S> } | { success: false; error: unknown }> {
    const s = schema as unknown as { safeParseAsync(data: unknown): Promise<unknown> };
    return (await s.safeParseAsync(data)) as { success: true; data: SchemaOutput<S> } | { success: false; error: unknown };
}

// --- Shape extraction ---
export function getObjectShape(schema: AnyObjectSchema | undefined): Record<string, AnySchema> | undefined {
    if (!schema) return undefined;
    return (schema as unknown as { shape?: Record<string, AnySchema> }).shape;
}

// --- Schema normalization ---
/**
 * Normalizes a schema to an object schema. Handles both:
 * - Already-constructed object schemas
 * - Raw shapes that need to be wrapped into object schemas
 */
export function normalizeObjectSchema(schema: AnySchema | ZodRawShapeCompat | undefined): AnyObjectSchema | undefined {
    if (!schema) return undefined;

    const asSchema = schema as unknown as { type?: string; shape?: unknown };

    // If it has a type property, it's a schema
    if (asSchema.type !== undefined) {
        // Check if it's an object schema
        if (asSchema.type === 'object' || asSchema.shape !== undefined) {
            return schema as AnyObjectSchema;
        }
        return undefined;
    }

    // No type property - might be a raw shape
    // Check if all values are schemas (have a type property)
    const values = Object.values(schema);
    if (values.length > 0 && values.every(v => typeof v === 'object' && v !== null && (v as { type?: unknown }).type !== undefined)) {
        return objectFromShape(schema as ZodRawShapeCompat);
    }

    return undefined;
}

// --- Error message extraction ---
/**
 * Safely extracts an error message from a parse result error.
 */
export function getParseErrorMessage(error: unknown): string {
    if (error && typeof error === 'object') {
        if ('message' in error && typeof error.message === 'string') {
            return error.message;
        }
        if ('issues' in error && Array.isArray(error.issues) && error.issues.length > 0) {
            const firstIssue = error.issues[0];
            if (firstIssue && typeof firstIssue === 'object' && 'message' in firstIssue) {
                return String(firstIssue.message);
            }
        }
        try {
            return JSON.stringify(error);
        } catch {
            return String(error);
        }
    }
    return String(error);
}

// --- Schema metadata access ---
/**
 * Gets the description from a schema, if available.
 */
export function getSchemaDescription(schema: AnySchema): string | undefined {
    return (schema as { description?: string }).description;
}

/**
 * Checks if a schema is optional.
 */
export function isSchemaOptional(schema: AnySchema): boolean {
    return (schema as unknown as { type?: string }).type === 'optional';
}

/**
 * Unwraps an optional schema to get the inner type.
 * Returns the schema unchanged if it's not optional.
 */
export function unwrapOptional(schema: AnySchema): AnySchema {
    const s = schema as unknown as { type?: string; unwrap?: () => AnySchema };
    if (s.type === 'optional' && typeof s.unwrap === 'function') {
        return s.unwrap();
    }
    return schema;
}
