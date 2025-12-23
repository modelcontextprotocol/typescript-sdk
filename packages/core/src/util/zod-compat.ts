// zod-compat.ts
// ----------------------------------------------------
// Unified types + helpers to accept Zod v3 and v4 (Mini)
// ----------------------------------------------------

import type * as z3 from 'zod/v3';
import * as z3rt from 'zod/v3';
import type * as z4 from 'zod/v4/core';
import * as z4mini from 'zod/v4-mini';

// --- Unified schema types ---
export type AnySchema = z3.ZodTypeAny | z4.$ZodType;
export type AnyObjectSchema = z3.AnyZodObject | z4.$ZodObject | AnySchema;
export type ZodRawShapeCompat = Record<string, AnySchema>;

// --- Internal property access helpers ---
// These types help us safely access internal properties that differ between v3 and v4
export interface ZodV3Internal {
    _def?: {
        typeName?: string;
        value?: unknown;
        values?: unknown[];
        shape?: Record<string, AnySchema> | (() => Record<string, AnySchema>);
        description?: string;
    };
    shape?: Record<string, AnySchema> | (() => Record<string, AnySchema>);
    value?: unknown;
}

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
export type SchemaOutput<S> = S extends z3.ZodTypeAny ? z3.infer<S> : S extends z4.$ZodType ? z4.output<S> : never;

export type SchemaInput<S> = S extends z3.ZodTypeAny ? z3.input<S> : S extends z4.$ZodType ? z4.input<S> : never;

/**
 * Infers the output type from a ZodRawShapeCompat (raw shape object).
 * Maps over each key in the shape and infers the output type from each schema.
 */
export type ShapeOutput<Shape extends ZodRawShapeCompat> = {
    [K in keyof Shape]: SchemaOutput<Shape[K]>;
};

// --- Runtime detection ---
export function isZ4Schema(s: AnySchema): s is z4.$ZodType {
    // Present on Zod 4 (Classic & Mini) schemas; absent on Zod 3
    const schema = s as unknown as ZodV4Internal;
    return !!schema._zod;
}

// --- Schema construction ---
export function objectFromShape(shape: ZodRawShapeCompat): AnyObjectSchema {
    const values = Object.values(shape);
    if (values.length === 0) return z4mini.object({}); // default to v4 Mini

    const allV4 = values.every(isZ4Schema);
    const allV3 = values.every(s => !isZ4Schema(s));

    if (allV4) return z4mini.object(shape as Record<string, z4.$ZodType>);
    if (allV3) return z3rt.object(shape as Record<string, z3.ZodTypeAny>);

    throw new Error('Mixed Zod versions detected in object shape.');
}

// --- Unified parsing ---
export function safeParse<S extends AnySchema>(
    schema: S,
    data: unknown
): { success: true; data: SchemaOutput<S> } | { success: false; error: unknown } {
    if (isZ4Schema(schema)) {
        // Mini exposes top-level safeParse
        const result = z4mini.safeParse(schema, data);
        return result as { success: true; data: SchemaOutput<S> } | { success: false; error: unknown };
    }
    const v3Schema = schema as z3.ZodTypeAny;
    const result = v3Schema.safeParse(data);
    return result as { success: true; data: SchemaOutput<S> } | { success: false; error: unknown };
}

export async function safeParseAsync<S extends AnySchema>(
    schema: S,
    data: unknown
): Promise<{ success: true; data: SchemaOutput<S> } | { success: false; error: unknown }> {
    if (isZ4Schema(schema)) {
        // Mini exposes top-level safeParseAsync
        const result = await z4mini.safeParseAsync(schema, data);
        return result as { success: true; data: SchemaOutput<S> } | { success: false; error: unknown };
    }
    const v3Schema = schema as z3.ZodTypeAny;
    const result = await v3Schema.safeParseAsync(data);
    return result as { success: true; data: SchemaOutput<S> } | { success: false; error: unknown };
}

// --- Shape extraction ---
export function getObjectShape(schema: AnyObjectSchema | undefined): Record<string, AnySchema> | undefined {
    if (!schema) return undefined;

    // Zod v3 exposes `.shape`; Zod v4 keeps the shape on `_zod.def.shape`
    let rawShape: Record<string, AnySchema> | (() => Record<string, AnySchema>) | undefined;

    if (isZ4Schema(schema)) {
        const v4Schema = schema as unknown as ZodV4Internal;
        rawShape = v4Schema._zod?.def?.shape;
    } else {
        const v3Schema = schema as unknown as ZodV3Internal;
        rawShape = v3Schema.shape;
    }

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
 * - Already-constructed object schemas (v3 or v4)
 * - Raw shapes that need to be wrapped into object schemas
 */
export function normalizeObjectSchema(schema: AnySchema | ZodRawShapeCompat | undefined): AnyObjectSchema | undefined {
    if (!schema) return undefined;

    // First check if it's a raw shape (Record<string, AnySchema>)
    // Raw shapes don't have _def or _zod properties and aren't schemas themselves
    if (typeof schema === 'object') {
        // Check if it's actually a ZodRawShapeCompat (not a schema instance)
        // by checking if it lacks schema-like internal properties
        const asV3 = schema as unknown as ZodV3Internal;
        const asV4 = schema as unknown as ZodV4Internal;

        // If it's not a schema instance (no _def or _zod), it might be a raw shape
        if (!asV3._def && !asV4._zod) {
            // Check if all values are schemas (heuristic to confirm it's a raw shape)
            const values = Object.values(schema);
            if (
                values.length > 0 &&
                values.every(
                    v =>
                        typeof v === 'object' &&
                        v !== null &&
                        ((v as unknown as ZodV3Internal)._def !== undefined ||
                            (v as unknown as ZodV4Internal)._zod !== undefined ||
                            typeof (v as { parse?: unknown }).parse === 'function')
                )
            ) {
                return objectFromShape(schema as ZodRawShapeCompat);
            }
        }
    }

    // If we get here, it should be an AnySchema (not a raw shape)
    // Check if it's already an object schema
    if (isZ4Schema(schema as AnySchema)) {
        // Check if it's a v4 object
        const v4Schema = schema as unknown as ZodV4Internal;
        const def = v4Schema._zod?.def;
        if (def && (def.type === 'object' || def.shape !== undefined)) {
            return schema as AnyObjectSchema;
        }
    } else {
        // Check if it's a v3 object
        const v3Schema = schema as unknown as ZodV3Internal;
        if (v3Schema.shape !== undefined) {
            return schema as AnyObjectSchema;
        }
    }

    return undefined;
}

// --- Error message extraction ---
/**
 * Safely extracts an error message from a parse result error.
 * Zod errors can have different structures, so we handle various cases.
 */
export function getParseErrorMessage(error: unknown): string {
    if (error && typeof error === 'object') {
        // Try common error structures
        if ('message' in error && typeof error.message === 'string') {
            return error.message;
        }
        if ('issues' in error && Array.isArray(error.issues) && error.issues.length > 0) {
            const firstIssue = error.issues[0];
            if (firstIssue && typeof firstIssue === 'object' && 'message' in firstIssue) {
                return String(firstIssue.message);
            }
        }
        // Fallback: try to stringify the error
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
 * Works with both Zod v3 and v4.
 *
 * Both versions expose a `.description` getter that returns the description
 * from their respective internal storage (v3: _def, v4: globalRegistry).
 */
export function getSchemaDescription(schema: AnySchema): string | undefined {
    return (schema as { description?: string }).description;
}

/**
 * Checks if a schema is optional.
 * Works with both Zod v3 and v4.
 */
export function isSchemaOptional(schema: AnySchema): boolean {
    if (isZ4Schema(schema)) {
        const v4Schema = schema as unknown as ZodV4Internal;
        return v4Schema._zod?.def?.type === 'optional';
    }
    const v3Schema = schema as unknown as ZodV3Internal;
    // v3 has isOptional() method
    if (typeof (schema as { isOptional?: () => boolean }).isOptional === 'function') {
        return (schema as { isOptional: () => boolean }).isOptional();
    }
    return v3Schema._def?.typeName === 'ZodOptional';
}

/**
 * Gets the literal value from a schema, if it's a literal schema.
 * Works with both Zod v3 and v4.
 * Returns undefined if the schema is not a literal or the value cannot be determined.
 */
export function getLiteralValue(schema: AnySchema): unknown {
    if (isZ4Schema(schema)) {
        const v4Schema = schema as unknown as ZodV4Internal;
        const def = v4Schema._zod?.def;
        if (def) {
            // Try various ways to get the literal value
            if (def.value !== undefined) return def.value;
            if (Array.isArray(def.values) && def.values.length > 0) {
                return def.values[0];
            }
        }
    }
    const v3Schema = schema as unknown as ZodV3Internal;
    const def = v3Schema._def;
    if (def) {
        if (def.value !== undefined) return def.value;
        if (Array.isArray(def.values) && def.values.length > 0) {
            return def.values[0];
        }
    }
    // Fallback: check for direct value property (some Zod versions)
    const directValue = (schema as { value?: unknown }).value;
    if (directValue !== undefined) return directValue;
    return undefined;
}
