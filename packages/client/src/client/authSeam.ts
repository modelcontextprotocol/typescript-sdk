/**
 * Auth-seam provenance stamp (internal — not part of the public API).
 *
 * Errors escaping a transport auth seam — the `authProvider.token()` read,
 * an `onUnauthorized` invocation (SDK adapter or custom user callback), the
 * 403 step-up flow, the transport's own auth-failure constructions — are
 * stamped at the throw boundary. The version-negotiation probe routes stamped
 * errors as auth outcomes; provenance is recorded where it is known, never
 * reconstructed from error types downstream.
 *
 * `Symbol.for` uses the global symbol registry, so the stamp survives a
 * duplicated SDK copy in one process (bundler double-install, version skew)
 * by design: both copies resolve the same symbol.
 */
const AUTH_SEAM = Symbol.for('mcp.authSeamEscape');

/**
 * Stamp `error` as an auth-seam escape and return it — identity-preserving
 * (the same object flows on, `instanceof` and `.cause` chains intact). A
 * frozen/sealed object is returned unstamped rather than replaced: identity
 * outranks provenance. Primitive throws cannot carry the stamp.
 */
export function markAuthSeamEscape<T>(error: T): T {
    if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
        try {
            Object.defineProperty(error, AUTH_SEAM, { value: true, configurable: true });
        } catch {
            // Frozen/sealed: leave unstamped.
        }
    }
    return error;
}

/** Whether `error` escaped through a transport auth seam. */
export function isAuthSeamEscape(error: unknown): boolean {
    return (
        ((typeof error === 'object' && error !== null) || typeof error === 'function') &&
        (error as Record<PropertyKey, unknown>)[AUTH_SEAM] === true
    );
}
