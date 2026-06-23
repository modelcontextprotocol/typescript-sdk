/**
 * Error classes thrown by the OAuth client flow ({@linkcode auth} and helpers).
 *
 * Each behavior change in the 2026-07-28 authorization requirements adds its
 * dedicated error class to this module so callers can `instanceof`-dispatch on
 * the failure mode without string-matching messages.
 */

import type { OAuthClientMetadata } from '@modelcontextprotocol/core';

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

/**
 * Thrown by `registerClient()` when the authorization server rejects a
 * Dynamic Client Registration request. Carries the HTTP status, the raw
 * response body, and the metadata that was submitted, so callers can inspect
 * the AS's `error` / `error_description` and retry with adjusted metadata
 * (for example a different `application_type`) per SEP-837.
 *
 * The `body` is the raw RFC 7591 error JSON; compare `JSON.parse(body).error`
 * against `OAuthErrorCode` (e.g. `OAuthErrorCode.InvalidRedirectUri`,
 * `OAuthErrorCode.InvalidClientMetadata`).
 *
 * Intentionally does **not** extend `OAuthError`: registration rejection is
 * not a recoverable-by-credential-invalidation condition, and staying outside
 * that hierarchy keeps it from being caught by `auth()`'s `OAuthError` retry
 * path.
 */
export class RegistrationRejectedError extends OAuthClientFlowError {
    /** HTTP status code returned by the registration endpoint. */
    public readonly status: number;
    /** Raw response body text (typically an RFC 7591 error JSON document). */
    public readonly body: string;
    /** The exact client metadata that was POSTed (after SDK defaults were applied). */
    public readonly submittedMetadata: OAuthClientMetadata;

    constructor(args: { status: number; body: string; submittedMetadata: OAuthClientMetadata }) {
        super(`Dynamic Client Registration rejected (HTTP ${args.status}): ${args.body}`);
        this.status = args.status;
        this.body = args.body;
        this.submittedMetadata = args.submittedMetadata;
    }
}

/**
 * Thrown by the token-exchange and refresh paths when the resolved token
 * endpoint is not `https:` and is not a loopback host (SEP-2207). This is a
 * configuration error — re-authorizing cannot fix it — so it intentionally does
 * **not** extend `OAuthError` and `auth()`'s refresh branch rethrows it instead
 * of falling through to a fresh `/authorize` redirect.
 */
export class InsecureTokenEndpointError extends OAuthClientFlowError {
    /** The token endpoint URL that was rejected. */
    public readonly tokenEndpoint: string;

    constructor(tokenEndpoint: string) {
        super(
            `Refusing to send credentials to non-https token endpoint '${tokenEndpoint}'. ` +
                `OAuth token requests MUST use TLS (localhost / 127.0.0.1 / ::1 are exempt).`
        );
        this.tokenEndpoint = tokenEndpoint;
    }
}

/**
 * Thrown by the HTTP client transport when the server responds with
 * `403 Forbidden` and `WWW-Authenticate: Bearer error="insufficient_scope"`,
 * and either (a) the transport's `onInsufficientScope` option is `'throw'`, or
 * (b) `onInsufficientScope` is the default `'reauthorize'` but the transport
 * has no {@linkcode index.OAuthClientProvider | OAuthClientProvider} to drive
 * step-up (e.g. a minimal `AuthProvider`, `requestInit`-only headers, or no
 * `authProvider`).
 *
 * Carries the challenge parameters so the host can decide whether to initiate
 * step-up authorization itself (e.g., behind a UX gate) or surface the error.
 *
 * Does **not** extend `OAuthError`: that class represents OAuth protocol errors
 * from the authorization server; this is a resource-server challenge surfaced
 * at the transport layer.
 *
 * All fields originate from the resource server's `WWW-Authenticate` header;
 * treat them as untrusted input when displaying or logging (this includes
 * `requiredScope`, which appears in the error message).
 */
/**
 * Thrown by `auth()` on the authorization-code callback leg when the
 * authorization server resolved by discovery differs from the one recorded in
 * `discoveryState()` at redirect time. The `authorization_code` and PKCE
 * `code_verifier` are bound to the AS that minted the code (RFC 7636); sending
 * them to a different AS's token endpoint is a credential-exfiltration vector.
 *
 * This is the only runtime check left in the SEP-2352 model — stored tokens and
 * client credentials are protected structurally by the `issuer` stamp instead.
 */
export class AuthorizationServerMismatchError extends OAuthClientFlowError {
    constructor(
        /** The issuer recorded in `discoveryState()` when the authorization redirect was issued. */
        public readonly recordedIssuer: string,
        /** The issuer resolved by discovery on this call. */
        public readonly currentIssuer: string
    ) {
        super(
            `Authorization server changed between redirect and callback ` +
                `(redirected to ${JSON.stringify(recordedIssuer)}, callback resolved ${JSON.stringify(currentIssuer)}); ` +
                `refusing to send authorization_code/code_verifier to a different token endpoint`
        );
    }
}

export class InsufficientScopeError extends OAuthClientFlowError {
    /** The `scope` value from the `WWW-Authenticate` challenge — the scopes the resource server says are required. */
    readonly requiredScope?: string;
    /** The `resource_metadata` URL from the `WWW-Authenticate` challenge, if present. */
    readonly resourceMetadataUrl?: URL;
    /** The `error_description` from the `WWW-Authenticate` challenge, if present. */
    readonly errorDescription?: string;

    constructor(init: { requiredScope?: string; resourceMetadataUrl?: URL; errorDescription?: string }) {
        super(`Insufficient scope${init.requiredScope ? `: required "${init.requiredScope}"` : ''}`);
        this.requiredScope = init.requiredScope;
        this.resourceMetadataUrl = init.resourceMetadataUrl;
        this.errorDescription = init.errorDescription;
    }
}
