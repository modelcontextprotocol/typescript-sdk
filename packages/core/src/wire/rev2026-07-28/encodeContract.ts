/**
 * The outbound result encode contract for the 2026-07-28 wire codec, as pure,
 * individually-testable steps. `encodeResult` applies them in order:
 *
 *  1. {@linkcode stampResultType} — the `resultType` discriminator. The SDK
 *     stamps `'complete'`; a handler-provided value passes through only for
 *     methods whose spec result vocabulary goes beyond `'complete'` (the
 *     multi round-trip request methods, whose results may be
 *     `input_required`). A non-`'complete'` value returned by a handler for
 *     any other method is a server bug and fails loudly (internal error)
 *     rather than being mis-typed on the wire.
 *  2. {@linkcode fillCacheFields} — the required `ttlMs`/`cacheScope` fields
 *     on cacheable results (SEP-2549), filled only when the post-stamp
 *     `resultType` is `'complete'` and the method is one of the cacheable
 *     operations. Resolution is most-specific-author-first: valid
 *     handler-returned values, then the configured cache hint attached by the
 *     server layer, then the conservative defaults
 *     `{ ttlMs: 0, cacheScope: 'private' }`. Invalid handler-returned values
 *     never reach the wire — they fall through to the next author.
 *
 * Ordering matters and is pinned by tests: the stamp runs before the fill, so
 * an `input_required` result is never given cache fields.
 */
import type { CacheHint } from '../../shared/resultCacheHints.js';
import {
    cacheHintFallbackOf,
    isCacheableResultMethod,
    isValidCacheScope,
    isValidCacheTtlMs,
    RESULT_CACHE_HINT_FALLBACK
} from '../../shared/resultCacheHints.js';
import { ProtocolErrorCode } from '../../types/enums.js';
import { ProtocolError } from '../../types/errors.js';
import type { Result } from '../../types/types.js';

/** The default cache policy when neither the handler nor configuration provides one. */
export const DEFAULT_CACHE_TTL_MS = 0;
export const DEFAULT_CACHE_SCOPE = 'private';

/**
 * Request methods whose spec result vocabulary goes beyond `'complete'` on the
 * 2026-07-28 revision: their results may be `input_required` (multi
 * round-trip requests), so a handler-provided `resultType` passes through the
 * stamp untouched. `subscriptions/listen` joins this set when the
 * subscriptions feature is served (its terminal result uses the same
 * mechanism).
 */
export const EXTENDED_RESULT_TYPE_METHODS: readonly string[] = ['tools/call', 'prompts/get', 'resources/read'];

/**
 * Step 1 of the encode contract: ensure the outbound result carries the
 * required `resultType` discriminator.
 *
 * - No handler-provided value → stamp `'complete'`.
 * - Handler-provided `'complete'` → kept as-is.
 * - Handler-provided non-`'complete'` value on a method whose vocabulary
 *   allows it ({@linkcode EXTENDED_RESULT_TYPE_METHODS}) → passes through.
 *   The value is forwarded verbatim — the wire vocabulary is an open union and
 *   the SDK does not validate the string, so emitting a `resultType` the
 *   negotiated revision does not define is the handler author's
 *   responsibility.
 * - Handler-provided non-`'complete'` value on any other method → internal
 *   error (loud): the value would be mis-typed on the wire, and silently
 *   rewriting it would hide a server bug.
 */
export function stampResultType(method: string, result: Result): Result {
    const provided = (result as Record<string, unknown>)['resultType'];
    if (provided === undefined) {
        return { ...result, resultType: 'complete' } as Result;
    }
    if (provided === 'complete') {
        return result;
    }
    if (EXTENDED_RESULT_TYPE_METHODS.includes(method)) {
        return result;
    }
    throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        `Handler for ${method} returned resultType '${String(provided)}', but results of ${method} only support 'complete' on protocol revision 2026-07-28`
    );
}

/**
 * Step 2 of the encode contract: fill the required `ttlMs`/`cacheScope` fields
 * on cacheable results.
 *
 * Applies only when the (post-stamp) `resultType` is `'complete'` and the
 * method is one of the cacheable operations; everything else is returned
 * untouched apart from removing the configured-hint carrier. Field resolution
 * is per field, most specific author first: a valid handler-returned value,
 * then the configured cache hint attached by the server layer, then the
 * defaults. Handler-returned values are validated at encode time (`ttlMs`
 * must be a non-negative integer, `cacheScope` must be `'public'` or
 * `'private'`); invalid values are ignored rather than emitted.
 */
export function fillCacheFields(method: string, result: Result): Result {
    const fallback = cacheHintFallbackOf(result);
    const resultType = (result as Record<string, unknown>)['resultType'];

    if (resultType !== 'complete' || !isCacheableResultMethod(method)) {
        // Not a cache-fill target. Drop the configured-hint carrier if one was
        // attached so it never travels past the encode seam.
        return fallback === undefined ? result : stripCacheHintFallback(result);
    }

    const provided = result as Record<string, unknown>;
    const ttlMs = isValidCacheTtlMs(provided['ttlMs']) ? (provided['ttlMs'] as number) : resolveTtlMs(fallback);
    const cacheScope = isValidCacheScope(provided['cacheScope']) ? (provided['cacheScope'] as string) : resolveCacheScope(fallback);

    const filled = { ...provided, ttlMs, cacheScope } as Record<string | symbol, unknown>;
    delete filled[RESULT_CACHE_HINT_FALLBACK];
    return filled as Result;
}

function resolveTtlMs(fallback: CacheHint | undefined): number {
    return fallback !== undefined && isValidCacheTtlMs(fallback.ttlMs) ? fallback.ttlMs : DEFAULT_CACHE_TTL_MS;
}

function resolveCacheScope(fallback: CacheHint | undefined): string {
    return fallback !== undefined && isValidCacheScope(fallback.cacheScope) ? fallback.cacheScope : DEFAULT_CACHE_SCOPE;
}

function stripCacheHintFallback(result: Result): Result {
    const copy = { ...result } as Record<string | symbol, unknown>;
    delete copy[RESULT_CACHE_HINT_FALLBACK];
    return copy as Result;
}
