// zod-compat.ts
// ----------------------------------------------------
// Types + helpers for Zod v4 (Mini) schemas
// ----------------------------------------------------

import type * as z4 from 'zod/v4/core';
import * as z4mini from 'zod/v4-mini';

// --- Schema types ---
export type AnySchema = z4.$ZodType;
export type AnyObjectSchema = z4.$ZodObject | AnySchema;
export type ZodRawShapeCompat = Record<string, AnySchema>;

// --- Internal property access helpers ---
export interface ZodV4Internal {
    _zod?: {
        def?: {
            type?: string;
            value?: unknown;
            values?: unknown[];
            shape?: Record<string, AnySchema> | (() => Record<string, AnySchema>);
        };
    };
    value?: unknown;
}

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
    const result = z4mini.safeParse(schema, data);
    return result as { success: true; data: SchemaOutput<S> } | { success: false; error: unknown };
}

export async function safeParseAsync<S extends AnySchema>(
    schema: S,
    data: unknown
): Promise<{ success: true; data: SchemaOutput<S> } | { success: false; error: unknown }> {
    const result = await z4mini.safeParseAsync(schema, data);
    return result as { success: true; data: SchemaOutput<S> } | { success: false; error: unknown };
}

// --- Shape extraction ---
export function getObjectShape(schema: AnyObjectSchema | undefined): Record<string, AnySchema> | undefined {
    if (!schema) return undefined;

    const v4Schema = schema as unknown as ZodV4Internal;
    const rawShape = v4Schema._zod?.def?.shape;

    if (!rawShape) return undefined;

    if (typeof rawShape === 'function') {
        try {
            return rawShape();
        } catch {
            return undefined;
        }
    }

    return rawShape;
}

// --- Schema normalization ---
/**
 * Normalizes a schema to an object schema. Handles both:
 * - Already-constructed object schemas
 * - Raw shapes that need to be wrapped into object schemas
 */
export function normalizeObjectSchema(schema: AnySchema | ZodRawShapeCompat | undefined): AnyObjectSchema | undefined {
    if (!schema) return undefined;

    // First check if it's a raw shape (Record<string, AnySchema>)
    if (typeof schema === 'object') {
        const asV4 = schema as unknown as ZodV4Internal;

        // If it's not a schema instance (no _zod), it might be a raw shape
        if (!asV4._zod) {
            // Check if all values are schemas (heuristic to confirm it's a raw shape)
            const values = Object.values(schema);
            if (
                values.length > 0 &&
                values.every(
                    v =>
                        typeof v === 'object' &&
                        v !== null &&
                        ((v as unknown as ZodV4Internal)._zod !== undefined || typeof (v as { parse?: unknown }).parse === 'function')
                )
            ) {
                return objectFromShape(schema as ZodRawShapeCompat);
            }
        }
    }

    // Check if it's already an object schema
    const v4Schema = schema as unknown as ZodV4Internal;
    const def = v4Schema._zod?.def;
    if (def && (def.type === 'object' || def.shape !== undefined)) {
        return schema as AnyObjectSchema;
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
    const v4Schema = schema as unknown as ZodV4Internal;
    return v4Schema._zod?.def?.type === 'optional';
}

/**
 * Gets the literal value from a schema, if it's a literal schema.
 * Returns undefined if the schema is not a literal or the value cannot be determined.
 */
export function getLiteralValue(schema: AnySchema): unknown {
    const v4Schema = schema as unknown as ZodV4Internal;
    const def = v4Schema._zod?.def;
    if (def) {
        if (def.value !== undefined) return def.value;
        if (Array.isArray(def.values) && def.values.length > 0) {
            return def.values[0];
        }
    }
    // Fallback: check for direct value property
    const directValue = (schema as { value?: unknown }).value;
    if (directValue !== undefined) return directValue;
    return undefined;
}
