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
 *
 * This function ensures that object schemas always include the `required` field,
 * even when empty. This is necessary for compatibility with OpenAI's strict
 * JSON schema mode, which requires `required` to always be present.
 *
 * @see https://github.com/modelcontextprotocol/typescript-sdk/issues/1659
 */
export function schemaToJson(schema: AnySchema, options?: { io?: 'input' | 'output' }): Record<string, unknown> {
    const jsonSchema = z.toJSONSchema(schema, options) as Record<string, unknown>;
    return ensureRequiredField(jsonSchema);
}

/**
 * Recursively ensures that all object schemas have a `required` field.
 * This is needed for OpenAI strict JSON schema compatibility.
 * 
 * Creates a new object rather than mutating in-place to avoid side effects
 * if the input schema is cached or reused.
 */
function ensureRequiredField(schema: Record<string, unknown>): Record<string, unknown> {
    // Create a shallow copy to avoid mutating the original
    const result = { ...schema };

    // If this is an object type without a required field, add an empty one
    if (result.type === 'object' && !('required' in result)) {
        result.required = [];
    }

    // Process nested properties recursively
    if (result.properties && typeof result.properties === 'object') {
        const newProperties: Record<string, unknown> = {};
        for (const key of Object.keys(result.properties)) {
            const prop = (result.properties as Record<string, unknown>)[key];
            if (prop && typeof prop === 'object') {
                newProperties[key] = ensureRequiredField(prop as Record<string, unknown>);
            } else {
                newProperties[key] = prop;
            }
        }
        result.properties = newProperties;
    }

    // Process additionalProperties if it's a schema
    if (result.additionalProperties && typeof result.additionalProperties === 'object') {
        result.additionalProperties = ensureRequiredField(result.additionalProperties as Record<string, unknown>);
    }

    // Process items for arrays
    if (result.items && typeof result.items === 'object') {
        result.items = ensureRequiredField(result.items as Record<string, unknown>);
    }

    // Process prefixItems for tuple schemas (JSON Schema 2020-12)
    if (Array.isArray(result.prefixItems)) {
        result.prefixItems = (result.prefixItems as Record<string, unknown>[]).map(s => 
            s && typeof s === 'object' ? ensureRequiredField(s) : s
        );
    }

    // Process allOf, anyOf, oneOf combiners
    for (const combiner of ['allOf', 'anyOf', 'oneOf'] as const) {
        if (Array.isArray(result[combiner])) {
            result[combiner] = (result[combiner] as Record<string, unknown>[]).map(s => ensureRequiredField(s));
        }
    }

    // Process 'not' schema
    if (result.not && typeof result.not === 'object') {
        result.not = ensureRequiredField(result.not as Record<string, unknown>);
    }

    // Process conditional schemas (if/then/else)
    for (const conditional of ['if', 'then', 'else'] as const) {
        if (result[conditional] && typeof result[conditional] === 'object') {
            result[conditional] = ensureRequiredField(result[conditional] as Record<string, unknown>);
        }
    }

    // Process $defs for referenced schemas
    if (result.$defs && typeof result.$defs === 'object') {
        const newDefs: Record<string, unknown> = {};
        for (const key of Object.keys(result.$defs)) {
            const def = (result.$defs as Record<string, unknown>)[key];
            if (def && typeof def === 'object') {
                newDefs[key] = ensureRequiredField(def as Record<string, unknown>);
            } else {
                newDefs[key] = def;
            }
        }
        result.$defs = newDefs;
    }

    return result;
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
