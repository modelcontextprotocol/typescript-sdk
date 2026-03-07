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
 * Inlines all local $ref pointers so the output is self-contained.
 *
 * LLMs consuming tool inputSchema cannot resolve $ref — they serialize
 * referenced parameters as strings instead of objects. While $ref was always
 * possible, PR #1460's switch to z.toJSONSchema() widened the blast radius
 * (globalRegistry, z.lazy). See ADR-0001.
 */
export function schemaToJson(schema: AnySchema, options?: { io?: 'input' | 'output' }): Record<string, unknown> {
    const jsonSchema = z.toJSONSchema(schema, options) as Record<string, unknown>;
    return dereferenceLocalRefs(jsonSchema);
}

/**
 * Resolves all local `$ref` pointers in a JSON Schema by inlining the
 * referenced definitions. Removes `$defs`/`definitions` from the output.
 *
 * - Caches resolved defs to avoid redundant work with diamond references
 *   (A→B→D, A→C→D — D is resolved once and reused).
 * - Detects cycles via a resolution stack and emits `{ type: "object" }`
 *   as a bounded fallback for recursive positions.
 * - Preserves sibling keywords alongside `$ref` per JSON Schema 2020-12
 *   (e.g. `{ "$ref": "...", "description": "override" }`).
 *
 * @internal Not part of the public API — only used by {@link schemaToJson}.
 *   Exported for testing only.
 */
export function dereferenceLocalRefs(schema: Record<string, unknown>): Record<string, unknown> {
    const defs: Record<string, unknown> =
        (schema['$defs'] as Record<string, unknown>) ?? (schema['definitions'] as Record<string, unknown>) ?? {};

    // Cache resolved defs to avoid redundant traversal on diamond references.
    // Note: cached values are shared by reference. This is safe because schemas
    // are treated as immutable after generation. If a consumer mutates a schema,
    // they'd need to deep-clone it first regardless.
    const cache = new Map<string, unknown>();

    function resolve(node: unknown, stack: Set<string>): unknown {
        if (node === null || typeof node !== 'object') return node;
        if (Array.isArray(node)) return node.map(item => resolve(item, stack));

        const obj = node as Record<string, unknown>;

        if (typeof obj['$ref'] === 'string') {
            const ref = obj['$ref'] as string;

            // Collect sibling keywords (JSON Schema 2020-12 allows keywords alongside $ref)
            const { $ref: _ref, ...siblings } = obj;
            void _ref;
            const hasSiblings = Object.keys(siblings).length > 0;

            let resolved: unknown;

            if (ref === '#') {
                // Self-referencing root
                if (stack.has(ref)) return { type: 'object' };
                const { $defs: _defs, definitions: _definitions, ...rest } = schema;
                void _defs;
                void _definitions;
                stack.add(ref);
                resolved = resolve(rest, stack);
                stack.delete(ref);
            } else {
                // Local definition: #/$defs/Name or #/definitions/Name
                const match = ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/);
                if (!match) return obj; // Non-local $ref — leave as-is

                const defName = match[1]!;
                const def = defs[defName];
                if (def === undefined) return obj; // Unknown def — leave as-is
                if (stack.has(defName)) return { type: 'object' };

                if (cache.has(defName)) {
                    resolved = cache.get(defName);
                } else {
                    stack.add(defName);
                    resolved = resolve(def, stack);
                    stack.delete(defName);
                    cache.set(defName, resolved);
                }
            }

            // Merge sibling keywords onto the resolved schema
            if (hasSiblings && resolved !== null && typeof resolved === 'object' && !Array.isArray(resolved)) {
                return { ...(resolved as Record<string, unknown>), ...siblings };
            }
            return resolved;
        }

        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(obj)) {
            if (key === '$defs' || key === 'definitions') continue;
            result[key] = resolve(value, stack);
        }
        return result;
    }

    return resolve(schema, new Set()) as Record<string, unknown>;
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
