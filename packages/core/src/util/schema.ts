import * as z from 'zod/v4';

/**
 * Base type for any Zod schema.
 * This is the canonical type to use when accepting user-provided schemas.
 */
export type AnySchema = z.core.$ZodType;

/**
 * A Zod schema for objects specifically (not unions).
 * Use this when you need to constrain to ZodObject schemas.
 */
export type AnyObjectSchema = z.core.$ZodObject;

/**
 * Extracts the input type from a Zod schema.
 */
export type SchemaInput<T extends AnySchema> = z.input<T>;

/**
 * Extracts the output type from a Zod schema.
 */
export type SchemaOutput<T extends AnySchema> = z.output<T>;

/**
 * Converts a Zod schema to JSON Schema.
 */
export function schemaToJson(schema: AnySchema, options?: { io?: 'input' | 'output' }): Record<string, unknown> {
    return z.toJSONSchema(schema, options) as Record<string, unknown>;
}

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

/**
 * Parses data against a Zod schema (asynchronous).
 * Returns a discriminated union with success/error.
 */
export function parseSchemaAsync<T extends AnySchema>(
    schema: T,
    data: unknown
): Promise<{ success: true; data: z.output<T> } | { success: false; error: z.core.$ZodError }> {
    return z.safeParseAsync(schema, data);
}

/**
 * Gets the shape of an object schema.
 * Returns undefined if the schema is not an object schema.
 */
export function getSchemaShape(schema: AnySchema): Record<string, AnySchema> | undefined {
    const candidate = schema as { shape?: unknown };
    if (candidate.shape && typeof candidate.shape === 'object') {
        return candidate.shape as Record<string, AnySchema>;
    }
    return undefined;
}

/**
 * Gets the description from a schema if it has one.
 */
export function getSchemaDescription(schema: AnySchema): string | undefined {
    const candidate = schema as { description?: string };
    return candidate.description;
}

/**
 * Checks if a schema is optional (accepts undefined).
 * Uses the public .type property which works in both zod/v4 and zod/v4/mini.
 */
export function isOptionalSchema(schema: AnySchema): boolean {
    const candidate = schema as { type?: string };
    return candidate.type === 'optional';
}

/**
 * Unwraps an optional schema to get the inner schema.
 * If the schema is not optional, returns it unchanged.
 * Uses the public .def.innerType property which works in both zod/v4 and zod/v4/mini.
 */
export function unwrapOptionalSchema(schema: AnySchema): AnySchema {
    if (!isOptionalSchema(schema)) {
        return schema;
    }
    const candidate = schema as { def?: { innerType?: AnySchema } };
    return candidate.def?.innerType ?? schema;
}
