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
 * Keyword-position keys whose values are instance data (not subschemas). A
 * `{$ref:…}` appearing inside one is a literal value, not a JSON Pointer to
 * rewrite. Only consulted when the current object is in keyword position —
 * a PROPERTY named `default`/`const` (under `properties`/`$defs`/…) is a name
 * position whose value IS a subschema and is recursed into.
 */
const REF_REWRITE_DATA_POSITION_KEYS: ReadonlySet<string> = new Set(['const', 'enum', 'default', 'examples']);

/**
 * Keyword-position keys whose value is a name→subschema map. Entries inside
 * such a map are in NAME position: their keys are author-chosen property
 * names (which may collide with JSON Schema keywords), their values are
 * subschemas to recurse into.
 */
const REF_REWRITE_NAME_MAP_KEYS: ReadonlySet<string> = new Set([
    'properties',
    'patternProperties',
    '$defs',
    'definitions',
    'dependentSchemas'
]);

/**
 * Wrap a non-object output schema in the 2025-era envelope:
 * `{type:'object', properties:{result:<natural>}, required:['result']}`.
 *
 * Same-document `$ref` / `$dynamicRef` JSON Pointers inside the natural schema
 * (e.g. `#/properties/foo` produced by zod for de-duplicated/recursive types)
 * are rewritten to account for the new `#/properties/result` root: bare `#` →
 * `#/properties/result`, `#/…` → `#/properties/result/…`. Cross-document refs
 * (anything not starting with `#`) are left untouched.
 *
 * The rewrite is position-aware: data-valued keywords
 * (`const`/`enum`/`default`/`examples`) in keyword position are NOT descended
 * into; the same names appearing as property names under
 * `properties`/`patternProperties`/`$defs`/`definitions`/`dependentSchemas`
 * ARE descended into (they're subschemas). The rewrite is also `$id`-scoped:
 * if the natural root carries `$id` no pointer is rewritten (same-document
 * refs inside resolve against the embedded `$id` base, not the wrapper root),
 * and any subtree that establishes its own `$id` is left untouched for the
 * same reason.
 */
export function wrapOutputSchemaForLegacy(natural: Readonly<Record<string, unknown>>): Record<string, unknown> {
    // A root `$schema` is hoisted to the wrapper root: it's a document-level
    // dialect declaration and the SEP-1613 dialect checks (both built-in
    // providers) only inspect the root, so leaving it under `properties.result`
    // would make a non-2020-12 schema pass the dialect check on the 2025
    // projection while the same tool is rejected on the 2026 era.
    const $schema = typeof natural['$schema'] === 'string' ? natural['$schema'] : undefined;
    // `$id` at the natural root: every same-document `#/…` ref inside resolves
    // against that base URI, not against the wrapper root — skip the rewrite.
    if (natural['$id'] !== undefined) {
        return { ...($schema !== undefined && { $schema }), type: 'object', properties: { result: natural }, required: ['result'] };
    }
    const rewriteRefs = (node: unknown, parentIsNameMap: boolean): unknown => {
        if (Array.isArray(node)) return node.map(item => rewriteRefs(item, false));
        if (node === null || typeof node !== 'object') return node;
        // A nested `$id` establishes its own resolution base for the subtree —
        // same-document refs inside are no longer relative to the wrapper root.
        // Only applies in keyword position (a property NAMED `$id` is just a name).
        if (!parentIsNameMap && (node as Record<string, unknown>)['$id'] !== undefined) return node;
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(node)) {
            if (parentIsNameMap) {
                // Name position: `k` is an author-chosen property/def name, `v` is a
                // subschema in keyword position. Never treat `k` as a keyword here.
                out[k] = rewriteRefs(v, false);
            } else if ((k === '$ref' || k === '$dynamicRef') && typeof v === 'string') {
                out[k] = v === '#' ? '#/properties/result' : v.startsWith('#/') ? `#/properties/result${v.slice(1)}` : v;
            } else if (REF_REWRITE_DATA_POSITION_KEYS.has(k)) {
                out[k] = v;
            } else if (REF_REWRITE_NAME_MAP_KEYS.has(k)) {
                out[k] = rewriteRefs(v, true);
            } else {
                out[k] = rewriteRefs(v, false);
            }
        }
        return out;
    };
    return {
        ...($schema !== undefined && { $schema }),
        type: 'object',
        properties: { result: rewriteRefs(natural, false) },
        required: ['result']
    };
}
