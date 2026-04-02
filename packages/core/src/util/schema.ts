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
 * referenced definitions.
 *
 * - Caches resolved defs to avoid redundant work with diamond references
 *   (A→B→D, A→C→D — D is resolved once and reused).
 * - Gracefully handles cycles — cyclic `$ref` are left in place with their
 *   `$defs` entries preserved. Non-cyclic refs in the same schema are still
 *   fully inlined. This avoids breaking existing servers that have recursive
 *   schemas which work (degraded) today.
 * - Preserves sibling keywords alongside `$ref` per JSON Schema 2020-12
 *   (e.g. `{ "$ref": "...", "description": "override" }`).
 *
 * @internal Exported for testing only.
 */
export function dereferenceLocalRefs(schema: Record<string, unknown>): Record<string, unknown> {
    // "$defs" is the standard keyword since JSON Schema 2019-09.
    // See: https://json-schema.org/draft/2020-12/json-schema-core#section-8.2.4
    // "definitions" is the legacy equivalent from drafts 04–07.
    // See: https://json-schema.org/draft-07/json-schema-validation#section-9
    // If both exist (malformed schema), "$defs" takes precedence.
    const defsKey = '$defs' in schema ? '$defs' : 'definitions' in schema ? 'definitions' : undefined;
    const defs: Record<string, unknown> = defsKey ? (schema[defsKey] as Record<string, unknown>) : {};

    // No definitions container — nothing to inline.
    // Note: $ref: "#" (root self-reference) is intentionally not handled — no schema
    // library produces it, no other MCP SDK handles it, and it's always cyclic.
    if (!defsKey) return schema;

    // Cache resolved defs to avoid redundant traversal on diamond references
    // (A→B→D, A→C→D — D is resolved once and reused). Cached values are shared
    // by reference, which is safe because schemas are immutable after generation.
    const resolvedDefs = new Map<string, unknown>();
    // Def names where a cycle was detected — these $ref are left in place
    // and their $defs entries must be preserved in the output.
    const cyclicDefs = new Set<string>();

    /**
     * Recursively inlines `$ref` pointers in a JSON Schema node by replacing
     * them with the referenced definition content.
     *
     * @param node - The current schema node being traversed.
     * @param stack - Def names currently being inlined (ancestor chain). If a
     *   def is encountered while already on the stack, it's a cycle — the
     *   `$ref` is left in place and the def name is added to `cyclicDefs`.
     */
    function inlineRefs(node: unknown, stack: Set<string>): unknown {
        if (node === null || typeof node !== 'object') return node;
        if (Array.isArray(node)) return node.map(item => inlineRefs(item, stack));

        const obj = node as Record<string, unknown>;

        // JSON Schema 2020-12 allows keywords alongside $ref (e.g. description, default).
        // Destructure to get the ref target and any sibling keywords to merge later.
        const { $ref: ref, ...siblings } = obj;
        if (typeof ref === 'string') {
            const hasSiblings = Object.keys(siblings).length > 0;

            let resolved: unknown;

            // Local definition reference: #/$defs/Name or #/definitions/Name
            const prefix = `#/${defsKey}/`;
            if (!ref.startsWith(prefix)) return obj; // Non-local $ref (external URL, etc.) — leave as-is

            const defName = ref.slice(prefix.length);
            const def = defs[defName];
            if (def === undefined) return obj; // Unknown def — leave as-is
            if (stack.has(defName)) {
                cyclicDefs.add(defName);
                return obj; // Cycle — leave $ref in place
            }

            if (resolvedDefs.has(defName)) {
                resolved = resolvedDefs.get(defName);
            } else {
                stack.add(defName);
                resolved = inlineRefs(def, stack);
                stack.delete(defName);
                resolvedDefs.set(defName, resolved);
            }

            // Merge sibling keywords onto the resolved definition
            if (hasSiblings && resolved !== null && typeof resolved === 'object' && !Array.isArray(resolved)) {
                const resolvedSiblings = Object.fromEntries(Object.entries(siblings).map(([k, v]) => [k, inlineRefs(v, stack)]));
                return { ...(resolved as Record<string, unknown>), ...resolvedSiblings };
            }
            return resolved;
        }

        // Regular object — recurse into values, skipping root-level $defs container
        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(obj)) {
            if (obj === schema && (key === '$defs' || key === 'definitions')) continue;
            result[key] = inlineRefs(value, stack);
        }
        return result;
    }

    const resolved = inlineRefs(schema, new Set()) as Record<string, unknown>;

    // Re-attach $defs only for cyclic definitions, using their resolved/cached
    // versions so that any non-cyclic refs inside them are already inlined.
    if (defsKey && cyclicDefs.size > 0) {
        const prunedDefs: Record<string, unknown> = {};
        for (const name of cyclicDefs) {
            prunedDefs[name] = resolvedDefs.get(name) ?? defs[name];
        }
        resolved[defsKey] = prunedDefs;
    }

    return resolved;
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
