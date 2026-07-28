/**
 * Invalid-reply provenance stamp (internal — not part of the public API).
 *
 * When the HTTP layer COMPLETES an exchange (2xx) but what came back is not a
 * valid JSON-RPC reply — a JSON body the strict message schema rejects, an
 * empty or unparseable body, or a 202 accepted-without-reply to the probe —
 * the transport stamps the error at the throw boundary, carrying the offending
 * body when one was parsed. The version-negotiation probe reads the stamp to
 * classify the reply as era evidence — deployed servers answer the unknown
 * `server/discover` probe with off-spec shapes such as the JSON-RPC 2.0
 * parse-error reply `{"error":{"code":-32700,...},"id":null}` — instead of
 * misreporting a server that answered as a network failure. As with the auth
 * seam, provenance is recorded where it is known, never reconstructed from
 * error types downstream.
 *
 * `Symbol.for` uses the global symbol registry, so the stamp survives a
 * duplicated SDK copy in one process (bundler double-install, version skew)
 * by design: both copies resolve the same symbol.
 */
const INVALID_REPLY = Symbol.for('mcp.invalidReplyBody');

/**
 * Stamp `error` as an invalid-reply escape (with the reply body that failed
 * validation, when one was parsed) and return it — identity-preserving (the
 * same object flows on, `instanceof` and `.cause` chains intact). A
 * frozen/sealed object is returned unstamped rather than replaced: identity
 * outranks provenance. Primitive throws cannot carry the stamp.
 */
export function markInvalidReplyEscape<T>(error: T, body: unknown): T {
    if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
        try {
            Object.defineProperty(error, INVALID_REPLY, { value: { body }, configurable: true });
        } catch {
            // Frozen/sealed: leave unstamped.
        }
    }
    return error;
}

/**
 * Read the reply body an invalid-reply escape was stamped with, or `undefined`
 * when `error` carries no stamp. The `{ body }` wrapper keeps a stamped
 * absent/`null` body distinguishable from an absent stamp.
 */
export function readInvalidReplyEscape(error: unknown): { body: unknown } | undefined {
    if (((typeof error === 'object' && error !== null) || typeof error === 'function') && INVALID_REPLY in error) {
        const stamp = (error as Record<PropertyKey, unknown>)[INVALID_REPLY];
        if (typeof stamp === 'object' && stamp !== null && 'body' in stamp) {
            return { body: (stamp as { body: unknown }).body };
        }
    }
    return undefined;
}
