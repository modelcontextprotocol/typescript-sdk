// zod-compat.ts
// ----------------------------------------------------
// Unified helpers that now prefer the Standard Schema interface while
// keeping backwards-compatible support for Zod v3/v4 schemas.
// ----------------------------------------------------

import type * as z3 from 'zod/v3';
import type * as z4 from 'zod/v4/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { SchemaError } from '@standard-schema/utils';

import * as z3rt from 'zod/v3';
import * as z4mini from 'zod/v4-mini';

// --- Unified schema types ---
type StandardLikeSchema = { readonly ['~standard']?: StandardSchemaV1.Props<unknown, unknown> };

export type AnySchema = (z3.ZodTypeAny | z4.$ZodType | StandardSchemaV1) & StandardLikeSchema;
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
            typeName?: string;
            value?: unknown;
            values?: unknown[];
            shape?: Record<string, AnySchema> | (() => Record<string, AnySchema>);
            description?: string;
        };
    };
    value?: unknown;
}

// --- Type inference helpers ---
export type SchemaOutput<S> = S extends { ['~standard']: { types: { output: infer O } } }
    ? O
    : S extends z3.ZodTypeAny
      ? z3.infer<S>
      : S extends z4.$ZodType
        ? z4.output<S>
        : unknown;

export type SchemaInput<S> = S extends { ['~standard']: { types: { input: infer I } } }
    ? I
    : S extends z3.ZodTypeAny
      ? z3.input<S>
      : S extends z4.$ZodType
        ? z4.input<S>
        : unknown;

/**
 * Infers the output type from a ZodRawShapeCompat (raw shape object).
 * Maps over each key in the shape and infers the output type from each schema.
 */
export type ShapeOutput<Shape extends ZodRawShapeCompat> = {
    [K in keyof Shape]: SchemaOutput<Shape[K]>;
};

export type ShapeInput<Shape extends ZodRawShapeCompat> = {
    [K in keyof Shape]: SchemaInput<Shape[K]>;
};

// --- Runtime detection ---
function isStandardSchema(schema: unknown): schema is StandardSchemaV1 {
    return !!schema && typeof schema === 'object' && '~standard' in schema;
}

export function isZ4Schema(s: AnySchema): s is z4.$ZodType {
    // Present on Zod 4 (Classic & Mini) schemas; absent on Zod 3
    const schema = s as unknown as ZodV4Internal;
    return !!schema._zod;
}

function isZodSchema(schema: AnySchema): schema is z3.ZodTypeAny | z4.$ZodType {
    if (isStandardSchema(schema) && schema['~standard']?.vendor === 'zod') {
        return true;
    }
    const internal = schema as unknown as ZodV3Internal | ZodV4Internal;
    if ('_def' in (internal as object)) {
        return !!(internal as ZodV3Internal)._def;
    }
    if ('_zod' in (internal as object)) {
        return !!(internal as ZodV4Internal)._zod;
    }
    return false;
}

function toIssues(error: unknown): StandardSchemaV1.Issue[] | undefined {
    if (error instanceof SchemaError) {
        return Array.from(error.issues);
    }
    if (Array.isArray(error)) {
        const typed = error as unknown[];
        if (typed.every(issue => issue && typeof issue === 'object' && 'message' in (issue as { message?: unknown }))) {
            return typed as StandardSchemaV1.Issue[];
        }
    }
    if (error && typeof error === 'object' && 'issues' in error && Array.isArray((error as { issues: unknown }).issues)) {
        const issues = (error as { issues: unknown[] }).issues;
        if (issues.every(issue => issue && typeof issue === 'object' && 'message' in (issue as { message?: unknown }))) {
            return issues as StandardSchemaV1.Issue[];
        }
    }
    return undefined;
}

// --- Schema construction ---
function createStandardObjectFromShape<Shape extends Record<string, AnySchema>>(shape: Shape): AnyObjectSchema {
    const standardSchema: StandardSchemaV1<ShapeInput<Shape>, ShapeOutput<Shape>> & { _shape: Shape } = {
        _shape: shape,
        '~standard': {
            version: 1,
            vendor: '@modelcontextprotocol/sdk',
            types: {
                input: {} as ShapeInput<Shape>,
                output: {} as ShapeOutput<Shape>
            },
            async validate(value) {
                if (value === null || typeof value !== 'object' || Array.isArray(value)) {
                    return {
                        issues: [
                            {
                                message: 'Expected object',
                                path: []
                            }
                        ]
                    };
                }

                const issues: StandardSchemaV1.Issue[] = [];
                const output: Record<string, unknown> = {};

                for (const [key, propSchema] of Object.entries(shape)) {
                    const propValue = (value as Record<string, unknown>)[key];
                    const result = await safeParseAsync(propSchema, propValue);

                    if (!result.success) {
                        const propIssues = toIssues(result.error) ?? [];
                        for (const issue of propIssues as StandardSchemaV1.Issue[]) {
                            const path = issue.path ? [key, ...issue.path] : [key];
                            issues.push({ ...issue, path });
                        }
                        if (propIssues.length === 0) {
                            issues.push({
                                message: getParseErrorMessage(result.error),
                                path: [key]
                            });
                        }
                    } else {
                        output[key] = result.data;
                    }
                }

                if (issues.length > 0) {
                    return { issues };
                }

                return { value: output as ShapeOutput<Shape> };
            }
        }
    };

    return standardSchema as unknown as AnyObjectSchema;
}

export function objectFromShape(shape: Record<string, AnySchema>): AnyObjectSchema {
    const values = Object.values(shape);
    if (values.length === 0) return z4mini.object({}); // default to v4 Mini

    const allV4 = values.every(isZ4Schema);
    const allV3 = values.every(s => isZodSchema(s) && !isZ4Schema(s));
    const hasZod = values.some(isZodSchema);
    const allStandardNonZod = values.every(s => isStandardSchema(s) && !isZodSchema(s));

    if (allV4) return z4mini.object(shape as Record<string, z4.$ZodType>);
    if (allV3) return z3rt.object(shape as Record<string, z3.ZodTypeAny>);
    if (hasZod) {
        throw new Error('Mixed Zod versions detected in object shape.');
    }
    if (allStandardNonZod) return createStandardObjectFromShape(shape);

    throw new Error('Mixed schema types detected in object shape. Please use a single schema library or provide a Standard Schema object.');
}

// --- Unified parsing ---
export function safeParse<S extends AnySchema>(
    schema: S,
    data: unknown
): { success: true; data: SchemaOutput<S> } | { success: false; error: unknown } {
    if (isStandardSchema(schema)) {
        const result = schema['~standard'].validate(data);
        if (result instanceof Promise) {
            return { success: false, error: new Error('Schema validation is async; use safeParseAsync instead') };
        }
        if (result.issues) {
            return { success: false, error: new SchemaError(result.issues) };
        }
        return { success: true, data: result.value as SchemaOutput<S> };
    }

    if (isZ4Schema(schema)) {
        const result = z4mini.safeParse(schema, data);
        return result as { success: true; data: SchemaOutput<S> } | { success: false; error: unknown };
    }

    if (isZodSchema(schema)) {
        const v3Schema = schema as z3.ZodTypeAny;
        const result = v3Schema.safeParse(data);
        return result as { success: true; data: SchemaOutput<S> } | { success: false; error: unknown };
    }

    return { success: false, error: new Error('Unsupported schema type') };
}

export async function safeParseAsync<S extends AnySchema>(
    schema: S,
    data: unknown
): Promise<{ success: true; data: SchemaOutput<S> } | { success: false; error: unknown }> {
    if (isStandardSchema(schema)) {
        const result = await schema['~standard'].validate(data);
        if (result.issues) {
            return { success: false, error: new SchemaError(result.issues) };
        }
        return { success: true, data: result.value as SchemaOutput<S> };
    }

    if (isZ4Schema(schema)) {
        // Mini exposes top-level safeParseAsync
        const result = await z4mini.safeParseAsync(schema, data);
        return result as { success: true; data: SchemaOutput<S> } | { success: false; error: unknown };
    }

    if (isZodSchema(schema)) {
        const v3Schema = schema as z3.ZodTypeAny;
        const result = await v3Schema.safeParseAsync(data);
        return result as { success: true; data: SchemaOutput<S> } | { success: false; error: unknown };
    }

    return { success: false, error: new Error('Unsupported schema type') };
}

// --- Shape extraction ---
export function getObjectShape(schema: AnyObjectSchema | undefined): Record<string, AnySchema> | undefined {
    if (!schema) return undefined;

    if (isStandardSchema(schema) && (schema as { _shape?: Record<string, AnySchema> })._shape) {
        return (schema as { _shape?: Record<string, AnySchema> })._shape;
    }

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

function isRawShapeCompat(value: unknown): value is ZodRawShapeCompat {
    if (typeof value !== 'object' || value === null) return false;
    if (isStandardSchema(value as AnySchema)) return false;
    const asV3 = value as ZodV3Internal;
    const asV4 = value as ZodV4Internal;
    return !asV3._def && !asV4._zod;
}

// --- Schema normalization ---
/**
 * Normalizes a schema to an object schema. Handles both:
 * - Already-constructed object schemas (Standard Schema or Zod)
 * - Raw shapes that need to be wrapped into object schemas
 */
export function normalizeObjectSchema(schema: AnySchema | ZodRawShapeCompat | undefined): AnyObjectSchema | undefined {
    if (!schema) return undefined;

    if (isStandardSchema(schema)) {
        return schema as AnyObjectSchema;
    }

    // First check if it's a raw shape (Record<string, AnySchema>)
    if (isRawShapeCompat(schema)) {
        return objectFromShape(schema);
    }

    // If we get here, it should be an AnySchema (not a raw shape)
    // Check if it's already an object schema
    const maybeSchema = schema as AnySchema;
    if (isZ4Schema(maybeSchema)) {
        // Check if it's a v4 object
        const v4Schema = maybeSchema as unknown as ZodV4Internal;
        const def = v4Schema._zod?.def;
        if (def && (def.typeName === 'object' || def.shape !== undefined)) {
            return maybeSchema as unknown as AnyObjectSchema;
        }
    } else if (isZodSchema(maybeSchema)) {
        // Check if it's a v3 object
        const v3Schema = maybeSchema as unknown as ZodV3Internal;
        if (v3Schema.shape !== undefined) {
            return maybeSchema as unknown as AnyObjectSchema;
        }
    }

    return undefined;
}

// --- Error message extraction ---
/**
 * Safely extracts an error message from a parse result error.
 * Handles Standard Schema issues, SchemaError, and Zod-style errors.
 */
export function getParseErrorMessage(error: unknown): string {
    if (error && typeof error === 'object') {
        // Standard Schema issues array
        if (Array.isArray(error) && error.length > 0) {
            const first = error[0];
            if (first && typeof first === 'object' && 'message' in first) {
                return String((first as { message: unknown }).message);
            }
        }

        if (error instanceof SchemaError) {
            return error.message;
        }

        // Try common error structures
        if ('message' in error && typeof (error as { message: unknown }).message === 'string') {
            return (error as { message: string }).message;
        }
        if (
            'issues' in error &&
            Array.isArray((error as { issues: unknown }).issues) &&
            (error as { issues: unknown[] }).issues.length > 0
        ) {
            const firstIssue = (error as { issues: unknown[] }).issues[0];
            if (firstIssue && typeof firstIssue === 'object' && 'message' in firstIssue) {
                return String((firstIssue as { message: unknown }).message);
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
 * Works with both Zod v3 and v4. Returns undefined for generic Standard Schema.
 */
export function getSchemaDescription(schema: AnySchema): string | undefined {
    if (isZ4Schema(schema)) {
        const v4Schema = schema as unknown as ZodV4Internal;
        return v4Schema._zod?.def?.description;
    }
    if (isZodSchema(schema)) {
        const v3Schema = schema as unknown as ZodV3Internal;
        // v3 may have description on the schema itself or in _def
        return (schema as { description?: string }).description ?? v3Schema._def?.description;
    }
    return undefined;
}

/**
 * Checks if a schema is optional.
 * Works with both Zod v3 and v4. For Standard Schema, attempts a lightweight check using undefined.
 */
export function isSchemaOptional(schema: AnySchema): boolean {
    if (isZ4Schema(schema)) {
        const v4Schema = schema as unknown as ZodV4Internal;
        return v4Schema._zod?.def?.typeName === 'ZodOptional';
    }
    if (isZodSchema(schema)) {
        const v3Schema = schema as unknown as ZodV3Internal;
        // v3 has isOptional() method
        if (typeof (schema as { isOptional?: () => boolean }).isOptional === 'function') {
            return (schema as { isOptional: () => boolean }).isOptional();
        }
        return v3Schema._def?.typeName === 'ZodOptional';
    }
    if (isStandardSchema(schema)) {
        const result = schema['~standard'].validate(undefined);
        if (!(result instanceof Promise)) {
            return !result.issues;
        }
    }
    return false;
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
    } else if (isZodSchema(schema)) {
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
    }
    return undefined;
}
