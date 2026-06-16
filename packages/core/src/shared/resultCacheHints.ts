/**
 * Cache-hint plumbing for cacheable results (protocol revision 2026-07-28).
 *
 * The 2026-07-28 revision requires `ttlMs`/`cacheScope` on the cacheable
 * result types (SEP-2549 `CacheableResult`). The values are resolved at the
 * era-aware encode seam (the 2026 wire codec's `encodeResult`), most specific
 * author first:
 *
 *   1. fields the handler returned on the result itself (when valid),
 *   2. a configured cache hint attached by the server layer
 *      (per-registration hint, then the server-level per-operation hint,
 *      combined per field — see {@linkcode attachCacheHintFallback}),
 *   3. the conservative defaults `{ ttlMs: 0, cacheScope: 'private' }`.
 *
 * The configured hint travels from the (era-blind) server configuration to the
 * (era-aware) encode seam on a symbol-keyed property of the result object —
 * {@linkcode RESULT_CACHE_HINT_FALLBACK}. Symbol-keyed properties are never
 * serialized to JSON, so attaching a hint can never change what a 2025-era
 * response looks like on the wire: only the 2026-era codec reads (and removes)
 * it while filling the required fields. The 2025-era codec has no cache code
 * path at all.
 */

/** The cache scopes defined for cacheable results (SEP-2549). */
export type CacheScope = 'public' | 'private';

/**
 * A cache hint for a cacheable result (protocol revision 2026-07-28): the
 * values to emit for `ttlMs` / `cacheScope` when the handler does not provide
 * them itself. Absent fields fall back to the conservative defaults
 * (`ttlMs: 0`, `cacheScope: 'private'`).
 */
export interface CacheHint {
    /** Cache lifetime in milliseconds. Must be a non-negative safe integer. */
    ttlMs?: number;
    /** Whether the result may be cached by shared caches (`public`) or only by the requesting client (`private`). */
    cacheScope?: CacheScope;
}

/**
 * The operations whose results are cacheable on the 2026-07-28 revision (the
 * `CacheableResult` extenders). This list is closed: no other operation's
 * result ever receives cache fields from the SDK.
 */
export const CACHEABLE_RESULT_METHODS = [
    'tools/list',
    'prompts/list',
    'resources/list',
    'resources/templates/list',
    'resources/read',
    'server/discover'
] as const;

/** A method whose result is cacheable on the 2026-07-28 revision. */
export type CacheableResultMethod = (typeof CACHEABLE_RESULT_METHODS)[number];

/** Whether the given method's result is cacheable on the 2026-07-28 revision. */
export function isCacheableResultMethod(method: string): method is CacheableResultMethod {
    return (CACHEABLE_RESULT_METHODS as readonly string[]).includes(method);
}

/**
 * The symbol-keyed carrier for a configured cache hint on a result object.
 * Symbol properties are invisible to JSON serialization, so the carrier can be
 * attached era-blind: only the 2026-era encode seam consumes it.
 */
export const RESULT_CACHE_HINT_FALLBACK: unique symbol = Symbol('modelcontextprotocol.resultCacheHintFallback');

/** A result object that may carry a configured cache-hint fallback. */
interface CacheHintCarrier {
    [RESULT_CACHE_HINT_FALLBACK]?: CacheHint;
}

/**
 * Attaches a configured cache hint to a result as the encode-time fallback.
 * Returns the result unchanged when there is nothing to attach. When a more
 * specific hint is already attached, the two hints are combined per field
 * (most-specific-author-wins for each of `ttlMs` and `cacheScope`): the
 * per-registration hint attached by the feature layer keeps every field it
 * sets, and the server-level per-operation hint only fills the fields the
 * more specific hint leaves unset.
 */
export function attachCacheHintFallback<T extends object>(result: T, hint: CacheHint | undefined): T {
    if (hint === undefined) {
        return result;
    }
    const attached = (result as CacheHintCarrier)[RESULT_CACHE_HINT_FALLBACK];
    if (attached === undefined) {
        return { ...result, [RESULT_CACHE_HINT_FALLBACK]: hint };
    }
    const merged: CacheHint = {};
    const ttlMs = attached.ttlMs ?? hint.ttlMs;
    if (ttlMs !== undefined) {
        merged.ttlMs = ttlMs;
    }
    const cacheScope = attached.cacheScope ?? hint.cacheScope;
    if (cacheScope !== undefined) {
        merged.cacheScope = cacheScope;
    }
    return { ...result, [RESULT_CACHE_HINT_FALLBACK]: merged };
}

/** Reads the configured cache-hint fallback attached to a result, if any. */
export function cacheHintFallbackOf(result: object): CacheHint | undefined {
    return (result as CacheHintCarrier)[RESULT_CACHE_HINT_FALLBACK];
}

/**
 * Whether a value is a valid `ttlMs`: a non-negative safe integer. Safe
 * integers are required because the wire schemas validate `ttlMs` as an
 * integer within `Number.MIN_SAFE_INTEGER`/`Number.MAX_SAFE_INTEGER`; a value
 * outside that range is treated as invalid here so it falls through to the
 * next author instead of being emitted and rejected downstream.
 */
export function isValidCacheTtlMs(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Whether a value is a valid `cacheScope`. */
export function isValidCacheScope(value: unknown): value is CacheScope {
    return value === 'public' || value === 'private';
}

/**
 * Validates a configured cache hint at configuration time. Throws a
 * `RangeError` naming the offending field, so misconfiguration fails at
 * startup/registration rather than silently degrading at encode time.
 */
export function assertValidCacheHint(hint: CacheHint, context: string): void {
    if (hint.ttlMs !== undefined && !isValidCacheTtlMs(hint.ttlMs)) {
        throw new RangeError(`Invalid cache hint for ${context}: ttlMs must be a non-negative safe integer (got ${String(hint.ttlMs)})`);
    }
    if (hint.cacheScope !== undefined && !isValidCacheScope(hint.cacheScope)) {
        throw new RangeError(
            `Invalid cache hint for ${context}: cacheScope must be 'public' or 'private' (got ${String(hint.cacheScope)})`
        );
    }
}
