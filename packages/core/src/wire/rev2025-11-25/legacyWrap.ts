/**
 * SEP-2106 legacy `outputSchema` wrap helpers (2025-era projection only).
 *
 * The neutral / 2026-07-28 model lets a tool's `outputSchema` carry any JSON
 * Schema root. The 2025-11-25 wire shape requires `type:'object'` at the root,
 * so when an era-blind handler advertises a non-object root, the 2025 codec's
 * `encodeResult('tools/list', …)` projects it down to
 * `{type:'object', properties:{result:<natural>}, required:['result']}`, and
 * `projectCallToolResult` wraps the matching `structuredContent` as
 * `{result:<value>}`. The 2026 codec's projections are the identity.
 *
 * These helpers are wire-layer property — they exist so the projection can
 * live behind {@link WireCodec.encodeResult} / {@link WireCodec.projectCallToolResult}
 * and never be re-derived in shared/ or server-side code.
 */

/**
 * Whether a JSON Schema's root is non-object: either an explicit non-object
 * `type`, or a typeless root such as `{anyOf:[…]}`. Object-shaped typeless
 * roots that the schema-conversion layer can prove are objects are stamped
 * `type:'object'` upstream, so they reach this predicate as object roots.
 */
export function isNonObjectJsonSchemaRoot(json: Readonly<Record<string, unknown>>): boolean {
    return json['type'] !== 'object';
}

/**
 * Keys whose values are instance-data positions in a JSON Schema (not
 * subschemas). A `{$ref:…}` appearing inside one is a literal value, not a
 * JSON Pointer to rewrite.
 */
const REF_REWRITE_DATA_POSITION_KEYS: ReadonlySet<string> = new Set(['const', 'enum', 'default', 'examples']);

/**
 * Wrap a non-object output schema in the 2025-era envelope:
 * `{type:'object', properties:{result:<natural>}, required:['result']}`.
 *
 * Same-document `$ref` / `$dynamicRef` JSON Pointers inside the natural schema
 * (e.g. `#/properties/foo` produced by zod for de-duplicated/recursive types)
 * are rewritten to account for the new `#/properties/result` root: bare `#` →
 * `#/properties/result`, `#/…` → `#/properties/result/…`. Cross-document refs
 * (anything not starting with `#`) are left untouched. Data positions
 * (`const`/`enum`/`default`/`examples`) are NOT descended into — their values
 * are instance data, not subschemas.
 */
export function wrapOutputSchemaForLegacy(natural: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const rewriteRefs = (node: unknown): unknown => {
        if (Array.isArray(node)) return node.map(item => rewriteRefs(item));
        if (node === null || typeof node !== 'object') return node;
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(node)) {
            if ((k === '$ref' || k === '$dynamicRef') && typeof v === 'string') {
                out[k] = v === '#' ? '#/properties/result' : v.startsWith('#/') ? `#/properties/result${v.slice(1)}` : v;
            } else if (REF_REWRITE_DATA_POSITION_KEYS.has(k)) {
                out[k] = v;
            } else {
                out[k] = rewriteRefs(v);
            }
        }
        return out;
    };
    return { type: 'object', properties: { result: rewriteRefs(natural) }, required: ['result'] };
}
