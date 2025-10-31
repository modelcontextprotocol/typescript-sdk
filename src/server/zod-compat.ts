// zod-compat.ts
// ----------------------------------------------------
// Unified types + helpers to accept Zod v3 and v4 (Mini)
// ----------------------------------------------------

import type * as z3 from 'zod/v3';
import type * as z4 from 'zod/v4/core';

import * as z3rt from 'zod/v3';
import * as z4mini from 'zod/v4-mini';

// --- Unified schema types ---
export type AnySchema = z3.ZodTypeAny | z4.$ZodType;
export type AnyObjectSchema = z3.AnyZodObject | z4.$ZodObject;

// Inferred I/O helpers (work for v3 and v4)
export type SchemaOutput<S> = S extends z3.ZodTypeAny ? z3.infer<S> : S extends z4.$ZodType ? z4.output<S> : never;

export type SchemaInput<S> = S extends z3.ZodTypeAny ? z3.input<S> : S extends z4.$ZodType ? z4.input<S> : never;

// Raw shape that can be all-v3 or all-v4 (no mixing)
export type ZodRawShapeCompat = Record<string, AnySchema>;

export type ObjectOutput<Shape extends ZodRawShapeCompat> = {
    [K in keyof Shape]: SchemaOutput<Shape[K]>;
};
export type ObjectInput<Shape extends ZodRawShapeCompat> = {
    [K in keyof Shape]: SchemaInput<Shape[K]>;
};

// --- Runtime guards ---
export function isZ4Schema(s: AnySchema): s is z4.$ZodType {
    // Present on Zod 4 (Classic & Mini) schemas; absent on Zod 3
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return !!(s as any)?._zod;
}

export function isZ4Object(o: AnyObjectSchema): o is z4.$ZodObject {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return isZ4Schema(o as any) && (o as any)._zod?.def?.type === 'object';
}

export function isZ3Object(o: AnyObjectSchema): o is z3.AnyZodObject {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return !isZ4Schema(o as any);
}

// --- Construction from a raw shape ---
// Requires that ALL entries are either v3 or v4; mixed shapes throw.
export function objectFromShape(shape: ZodRawShapeCompat): AnyObjectSchema {
    const values = Object.values(shape);
    if (values.length === 0) return z4mini.object({}); // default to v4 Mini for empty

    const allV4 = values.every(isZ4Schema);
    const allV3 = values.every(s => !isZ4Schema(s));

    if (allV4) return z4mini.object(shape as Record<string, z4.$ZodType>);
    if (allV3) return z3rt.object(shape as Record<string, z3.ZodTypeAny>);

    throw new Error('Mixed Zod versions detected in object shape.');
}

// Accept object schema or raw shape; normalize to concrete object schema (v3 or v4)
export function normalizeObjectSchema(s?: AnyObjectSchema | ZodRawShapeCompat): AnyObjectSchema | undefined {
    if (!s) return undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof (s as any).safeParse === 'function' || (s as any)?._zod) {
        return s as AnyObjectSchema;
    }

    // It's a raw shape
    return objectFromShape(s as ZodRawShapeCompat);
}

// --- Unified safeParse over v3/v4 ---
export function safeParse<S extends AnySchema>(
    schema: S,
    data: unknown
): { success: true; data: SchemaOutput<S> } | { success: false; error: unknown } {
    if (isZ4Schema(schema)) {
        // Mini exposes top-level safeParse
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return z4mini.safeParse(schema as z4.$ZodType, data) as any;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (schema as z3.ZodTypeAny).safeParse(data) as any;
}

// after the existing `safeParse(...)` export
export async function safeParseAsync<S extends AnySchema>(
    schema: S,
    data: unknown
): Promise<{ success: true; data: SchemaOutput<S> } | { success: false; error: Error }> {
    if (isZ4Schema(schema)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (await z4mini.safeParseAsync(schema as z4.$ZodType, data)) as any;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (schema as z3.ZodTypeAny).safeParseAsync(data) as any;
}
