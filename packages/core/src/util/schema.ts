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
 * Resolves all local `$ref` pointers in a JSON Schema by inlining the
 * referenced definitions. Removes `$defs`/`definitions` from the output.
 *
 * - Caches resolved defs to avoid redundant work with diamond references
 *   (A→B→D, A→C→D — D is resolved once and reused).
 * - Throws on cycles — recursive schemas cannot be represented without `$ref`
 *   and LLMs cannot handle them. Fail loud so the developer knows to
 *   restructure their schema.
 * - Preserves sibling keywords alongside `$ref` per JSON Schema 2020-12
 *   (e.g. `{ "$ref": "...", "description": "override" }`).
 *
 * @internal Exported for testing only.
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
                if (stack.has(ref)) {
                    throw new Error(
                        'Recursive schema detected: the root schema references itself. ' +
                            'MCP tool schemas cannot contain cycles because LLMs cannot resolve $ref pointers.'
                    );
                }
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

                if (stack.has(defName)) {
                    throw new Error(
                        `Recursive schema detected: cycle through definition "${defName}". ` +
                            'MCP tool schemas cannot contain cycles because LLMs cannot resolve $ref pointers.'
                    );
                }

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
                const resolvedSiblings = Object.fromEntries(Object.entries(siblings).map(([k, v]) => [k, resolve(v, stack)]));
                return { ...(resolved as Record<string, unknown>), ...resolvedSiblings };
            }
            return resolved;
        }

        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(obj)) {
            if (obj === schema && (key === '$defs' || key === 'definitions')) continue;
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
