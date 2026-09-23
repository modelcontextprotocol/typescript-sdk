/**
 * Shared bounded-cache helpers for validator providers.
 *
 * Both `AjvJsonSchemaValidator` and `CfWorkerJsonSchemaValidator` compile
 * (or instantiate) a validator per distinct schema. Without caching, repeated
 * calls with identical schemas recompile every time; without a bound, a
 * caller whose schemas genuinely evolve keeps every distinct schema ever
 * seen. See #2605.
 */

/** Number of distinct schemas a provider keeps compiled before evicting the oldest. */
export const VALIDATOR_CACHE_LIMIT = 1000;

/** Recursively sort object keys so structurally equal JSON has one representation. */
export function sortJsonKeys(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(item => sortJsonKeys(item));
    }
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
            Object.keys(value as Record<string, unknown>)
                .toSorted()
                .map(key => [key, sortJsonKeys((value as Record<string, unknown>)[key])])
        );
    }
    return value;
}

/**
 * Canonical cache key for a schema: JSON-serialized with object keys
 * recursively sorted, so structurally identical schemas (regardless of key
 * order or object identity) share one entry. Returns `undefined` for schemas
 * that cannot be serialized (e.g. cyclic objects).
 */
export function canonicalJson(value: unknown): string | undefined {
    try {
        return JSON.stringify(sortJsonKeys(value));
    } catch {
        return undefined;
    }
}

/**
 * FIFO-bounded string-keyed cache. Evicts the oldest entry once `limit` is
 * exceeded, so the cache cannot grow without bound. FIFO (rather than LRU) is
 * deliberate: schema catalogs are refreshed wholesale, so recency is not a
 * reliable signal of reuse.
 */
export function createBoundedCache<T>(limit: number): {
    get(key: string): T | undefined;
    set(key: string, value: T): void;
} {
    const entries = new Map<string, T>();
    return {
        get(key: string): T | undefined {
            return entries.get(key);
        },
        set(key: string, value: T): void {
            entries.set(key, value);
            if (entries.size > limit) {
                const oldest = entries.keys().next();
                if (!oldest.done) {
                    entries.delete(oldest.value);
                }
            }
        }
    };
}
