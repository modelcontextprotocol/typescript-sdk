/**
 * Error classes thrown by the OAuth client flow ({@linkcode auth} and helpers).
 *
 * Each behavior change in the 2026-07-28 authorization requirements adds its
 * dedicated error class to this module so callers can `instanceof`-dispatch on
 * the failure mode without string-matching messages.
 */

/**
 * Base class for the OAuth-client-flow error family. Concrete subclasses are
 * added to this module alongside the SEP-2468/837/2207/2350/2352 behavior
 * changes that throw them, so callers can catch the whole family with a single
 * `instanceof OAuthClientFlowError` guard once those land.
 *
 * @remarks Nothing in the SDK throws this base class directly. In the release
 * that introduces it no subclass exists yet — the guard is a forward-compat
 * hook and will not match anything until the first behavior change ships.
 */
export class OAuthClientFlowError extends Error {
    constructor(message: string) {
        super(message);
        this.name = new.target.name;
    }
}

/**
 * Thrown when an authorization-server issuer identifier fails validation.
 *
 * Two checks raise this error, distinguished by {@linkcode IssuerMismatchError.kind | kind}:
 * - `'metadata'` — the `issuer` in fetched authorization-server metadata does
 *   not match the issuer identifier the well-known URL was constructed from
 *   (RFC 8414 §3.3 / OpenID Connect Discovery §4.3).
 * - `'authorization_response'` — the `iss` parameter on the authorization
 *   callback failed RFC 9207 §2.4 validation against the recorded issuer.
 *
 * Intentionally does **not** extend `OAuthError`: the `auth()`
 * orchestrator's `OAuthError` retry block must not swallow this — a mix-up
 * indication is fatal for the flow, not a retryable credential problem.
 *
 * On the `'authorization_response'` path the {@linkcode IssuerMismatchError.received | received}
 * value is attacker-controllable in a mix-up attack; callers **MUST NOT** display
 * it (or any `error`/`error_description`/`error_uri` from the same callback) to
 * end users. The values are JSON-encoded in the message to neutralize log-injection.
 */
export class IssuerMismatchError extends OAuthClientFlowError {
    /** Which check failed — metadata echo (RFC 8414 §3.3) or authorization-response `iss` (RFC 9207). */
    readonly kind: 'metadata' | 'authorization_response';
    /** The issuer the client expected (from validated metadata / discovery input). */
    readonly expected: string | undefined;
    /** The issuer value that was received. Attacker-controllable on the `'authorization_response'` path. */
    readonly received: string | undefined;

    constructor(kind: 'metadata' | 'authorization_response', expected: string | undefined, received: string | undefined) {
        const where = kind === 'metadata' ? 'authorization server metadata (RFC 8414 §3.3)' : 'authorization response (RFC 9207)';
        // JSON-stringify embedded values so attacker-supplied control characters cannot forge log lines.
        super(`Issuer mismatch in ${where}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(received)}`);
        this.kind = kind;
        this.expected = expected;
        this.received = received;
    }
}
