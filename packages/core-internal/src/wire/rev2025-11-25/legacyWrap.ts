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
    'dependentSchemas',
    // draft-07's dependentSchemas predecessor; its array-of-strings form is
    // unaffected (string arrays contain no refs).
    'dependencies'
]);

/**
 * Whether a subtree's `$id` establishes a new resolution base. A fragment-only
 * `$id` (`"#item"`, the draft-07/06 spelling of 2020-12's `$anchor`) does not
 * change the RFC 3986 base URI — same-document pointers inside still resolve
 * against the document root and must be rewritten.
 */
function establishesNewBase(id: unknown): boolean {
    return id !== undefined && !(typeof id === 'string' && id.startsWith('#'));
}

/**
 * Position-aware scan for a keyword-position `$recursiveAnchor: true` (2019-09). Its presence
 * anywhere in the document switches `$recursiveRef` from static (`$ref`-equivalent) to dynamic
 * re-resolution, which relocation cannot preserve — see the coverage block below.
 */
function hasRecursiveAnchor(node: unknown, parentIsNameMap: boolean): boolean {
    if (Array.isArray(node)) return node.some(item => hasRecursiveAnchor(item, false));
    if (node === null || typeof node !== 'object') return false;
    return Object.entries(node).some(([k, v]) => {
        if (parentIsNameMap) return hasRecursiveAnchor(v, false);
        if (k === '$recursiveAnchor') return v === true;
        if (REF_REWRITE_DATA_POSITION_KEYS.has(k)) return false;
        return hasRecursiveAnchor(v, REF_REWRITE_NAME_MAP_KEYS.has(k));
    });
}

/*
 * Reference/base-affecting keyword coverage across the four supported dialects
 * (2020-12, 2019-09, draft-07, draft-06). Every entry is rewritten, position-guarded,
 * or N/A with the reason; legacyWrap.test.ts pins each handled row:
 * - `$ref` (all dialects): JSON-Pointer forms `#`/`#/…` rewritten; other values untouched.
 * - `$dynamicRef` (2020-12): pointer forms rewritten like `$ref`; plain-name form (`#name`)
 *   untouched — see `$anchor`.
 * - `$dynamicAnchor` (2020-12): N/A — location-independent plain name; the envelope adds no
 *   anchors and the natural schema moves whole, so dynamic resolution is unchanged.
 * - `$anchor` (2019-09/2020-12): N/A — same as `$dynamicAnchor`; `#name` refs are fragments,
 *   not pointers, and are never rewritten.
 * - `$recursiveRef` (2019-09): value is restricted to `#`. Anchor-less documents: converted to
 *   `$ref: '#/properties/result'` (statically equivalent). Documents with a keyword-position
 *   `$recursiveAnchor`: left verbatim — KNOWN LIMITATION: relocation cannot preserve dynamic
 *   re-resolution (a static rewrite would freeze it and the envelope root carries no anchor),
 *   so anchored recursion still mis-resolves on the 2025 projection.
 * - `$recursiveAnchor` (2019-09): boolean, not a location — only consulted by the scan above.
 * - `$id`, URI form (all dialects): establishes a new base — subtree skipped (root and nested).
 * - `$id`, fragment form (draft-07/06 anchor spelling; illegal in 2019-09/2020-12): does not
 *   change the base — descended into.
 * - `$schema`: hoisted to the wrapper root so dialect dispatch and the graceful
 *   unsupported-dialect rejection see it.
 * - `$vocabulary` (2019-09/2020-12): N/A — meta-schema-only keyword, inert in tool schemas.
 * - Name→subschema maps (`properties`, `patternProperties`, `$defs`, `definitions`,
 *   `dependentSchemas`, draft-07/06 `dependencies`): entries are name positions; their keys
 *   are never treated as keywords.
 * - Data-position keywords (`const`/`enum`/`default`/`examples`): values are instance data,
 *   never descended into.
 */
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
 * `properties`/`patternProperties`/`$defs`/`definitions`/`dependentSchemas`/
 * `dependencies` ARE descended into (they're subschemas). The rewrite is also
 * `$id`-scoped: if the natural root carries a base-establishing `$id` no
 * pointer is rewritten (same-document refs inside resolve against the embedded
 * `$id` base, not the wrapper root), and any subtree that establishes its own
 * `$id` is left untouched for the same reason. Fragment-only `$id` (`"#item"`,
 * draft-07's anchor spelling) does not establish a base and IS descended into.
 */
export function wrapOutputSchemaForLegacy(natural: Readonly<Record<string, unknown>>): Record<string, unknown> {
    // A root `$schema` is hoisted to the wrapper root: it's a document-level
    // dialect declaration and the built-in providers' dialect dispatch only
    // inspects the root, so leaving it under `properties.result` would make
    // the wrapper compile under the default 2020-12 engine (an opaque Ajv2020
    // compile error on draft-07 tuple-form `items` instead of the classic
    // engine's tuple semantics) while the same tool dispatches to the declared
    // dialect on the 2026 era — and hide an unsupported dialect from the
    // graceful rejection.
    const $schema = typeof natural['$schema'] === 'string' ? natural['$schema'] : undefined;
    // A base-establishing `$id` at the natural root: every same-document `#/…`
    // ref inside resolves against that base URI, not against the wrapper root —
    // skip the rewrite. Fragment-only `$id` keeps the document-root base.
    if (establishesNewBase(natural['$id'])) {
        return { ...($schema !== undefined && { $schema }), type: 'object', properties: { result: natural }, required: ['result'] };
    }
    // Anchor-less documents only: `$recursiveRef: '#'` is statically `$ref: '#'`-equivalent
    // and is converted to the rewritten pointer. See the coverage block above.
    const convertRecursiveRefs = !hasRecursiveAnchor(natural, false);
    const rewriteRefs = (node: unknown, parentIsNameMap: boolean): unknown => {
        if (Array.isArray(node)) return node.map(item => rewriteRefs(item, false));
        if (node === null || typeof node !== 'object') return node;
        // A nested base-establishing `$id` owns resolution for the subtree —
        // same-document refs inside are no longer relative to the wrapper root.
        // Only applies in keyword position (a property NAMED `$id` is just a name).
        if (!parentIsNameMap && establishesNewBase((node as Record<string, unknown>)['$id'])) return node;
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(node)) {
            if (parentIsNameMap) {
                // Name position: `k` is an author-chosen property/def name, `v` is a
                // subschema in keyword position. Never treat `k` as a keyword here.
                out[k] = rewriteRefs(v, false);
            } else if ((k === '$ref' || k === '$dynamicRef') && typeof v === 'string') {
                out[k] = v === '#' ? '#/properties/result' : v.startsWith('#/') ? `#/properties/result${v.slice(1)}` : v;
            } else if (k === '$recursiveRef' && v === '#' && convertRecursiveRefs && !('$ref' in node)) {
                out['$ref'] = '#/properties/result';
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
