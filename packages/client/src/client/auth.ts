import { CORS_IS_POSSIBLE } from '@modelcontextprotocol/client/_shims';
import type {
    AuthorizationServerMetadata,
    DiscoveryUrlContext,
    DiscoveryUrlPolicyOptions,
    DiscoveryUrlProducer,
    DiscoveryUrlPurpose,
    DiscoveryUrlSource,
    FetchLike,
    OAuthClientInformation,
    OAuthClientInformationFull,
    OAuthClientInformationMixed,
    OAuthClientMetadata,
    OAuthMetadata,
    OAuthProtectedResourceMetadata,
    OAuthTokens,
    StoredOAuthClientInformation,
    StoredOAuthTokens
} from '@modelcontextprotocol/core-internal';
import {
    assertAllowedDiscoveryUrl,
    brandedHasInstance,
    checkResourceAllowed,
    DiscoveryUrlBlockedError,
    LATEST_PROTOCOL_VERSION,
    OAuthClientInformationFullSchema,
    OAuthError,
    OAuthErrorCode,
    OAuthErrorResponseSchema,
    OAuthMetadataSchema,
    OAuthProtectedResourceMetadataSchema,
    OAuthTokensSchema,
    OMIT_BASE_HEADERS,
    OpenIdProviderDiscoveryMetadataSchema,
    resourceUrlFromServerUrl,
    stampErrorBrands
} from '@modelcontextprotocol/core-internal';
import pkceChallenge from 'pkce-challenge';

import {
    AuthorizationServerMismatchError,
    InsecureTokenEndpointError,
    IssuerMismatchError,
    RedirectFilteredResponseError,
    RegistrationRejectedError
} from './authErrors';

// Re-exported for back-compat — the canonical home is ./authErrors.js.
export { AuthorizationServerMismatchError, InsecureTokenEndpointError, IssuerMismatchError, RegistrationRejectedError } from './authErrors';

/**
 * Function type for adding client authentication to token requests.
 */
export type AddClientAuthentication = (
    headers: Headers,
    params: URLSearchParams,
    url: string | URL,
    metadata?: AuthorizationServerMetadata
) => void | Promise<void>;

/**
 * Context passed to {@linkcode AuthProvider.onUnauthorized} when the server
 * responds with 401. Provides everything needed to refresh credentials.
 */
export interface UnauthorizedContext {
    /** The 401 response — inspect `WWW-Authenticate` for resource metadata, scope, etc. */
    response: Response;
    /** The MCP server URL, for passing to {@linkcode auth} or discovery helpers. */
    serverUrl: URL;
    /** Fetch function configured with the transport's `requestInit`, for making auth requests. */
    fetchFn: FetchLike;
}

/**
 * Minimal interface for authenticating MCP client transports with bearer tokens.
 *
 * Transports call {@linkcode AuthProvider.token | token()} before every request
 * to obtain the current token, and {@linkcode AuthProvider.onUnauthorized | onUnauthorized()}
 * (if provided) when the server responds with 401, giving the provider a chance
 * to refresh credentials before the transport retries once.
 *
 * For simple cases (API keys, gateway-managed tokens), implement only `token()`:
 * ```typescript
 * const authProvider: AuthProvider = { token: async () => process.env.API_KEY };
 * ```
 *
 * For OAuth flows, pass an {@linkcode OAuthClientProvider} directly — transports
 * accept either shape and adapt OAuth providers automatically via {@linkcode adaptOAuthProvider}.
 */
export interface AuthProvider {
    /**
     * Returns the current bearer token, or `undefined` if no token is available.
     * Called before every request.
     */
    token(): Promise<string | undefined>;

    /**
     * Called when the server responds with 401. If provided, the transport will
     * await this, then retry the request once. If the retry also gets 401, or if
     * this method is not provided, the transport throws {@linkcode UnauthorizedError}.
     *
     * Implementations should refresh tokens, re-authenticate, etc. — whatever is
     * needed so the next `token()` call returns a valid token.
     */
    onUnauthorized?(ctx: UnauthorizedContext): Promise<void>;
}

/**
 * Context passed to the credential-persistence methods on
 * {@linkcode OAuthClientProvider} — `clientInformation` / `saveClientInformation`
 * and `tokens` / `saveTokens`. Carries the resolved authorization-server `issuer`
 * so provider implementations can key persisted credentials per authorization
 * server (RFC 6749 §2.2 — client identifiers are unique to the AS that issued
 * them). Providers that store a single credential set may ignore it.
 */
export interface OAuthClientInformationContext {
    /**
     * The authorization server's `issuer` identifier from its validated metadata
     * document, used as the binding key for persisted credentials.
     */
    issuer: string;
}

/**
 * SEP-2352 stamp check: returns `stored` only when its `issuer` stamp matches the
 * resolved authorization server. A stamp that names a *different* issuer reads back
 * as `undefined`, so a credential issued by one authorization server is never reused
 * at another — the flow falls through to re-registration / re-authorization exactly
 * as if nothing were stored. An unstamped value (legacy provider or pre-SEP-2352
 * storage) is returned as-is with a `console.warn`; {@linkcode auth} writes the
 * stamp back on first use so the window closes after one call.
 *
 * {@linkcode auth} stamps every value it writes via `saveTokens` / `saveClientInformation`,
 * so a provider that round-trips the stored object verbatim is protected with no extra
 * code. Providers that hold credentials for multiple authorization servers key their
 * storage on `ctx.issuer` instead.
 *
 * @param opts.canPersistStamp - When `false`, suppresses the unstamped-credential
 *   warning: the caller cannot back-stamp (no `saveClientInformation`), so the
 *   "binding on first use" claim would be false and would fire on every call.
 */
export function discardIfIssuerMismatch<T extends { issuer?: string }>(
    stored: T | undefined,
    issuer: string,
    opts?: { canPersistStamp?: boolean }
): T | undefined {
    if (stored === undefined) return undefined;
    if (stored.issuer === undefined) {
        if (opts?.canPersistStamp !== false) {
            console.warn(
                `[mcp-sdk] SEP-2352: stored OAuth credential has no 'issuer' stamp (pre-upgrade storage or ` +
                    `provider not round-tripping the value). SEP-2352 isolation is inactive for this read; ` +
                    `ensure your provider round-trips the issuer field.`
            );
        }
        return stored;
    }
    return issuersMatch(stored.issuer, issuer) ? stored : undefined;
}

/**
 * SEP-2352 issuer-identity comparison. Tolerates a single trailing `/` difference,
 * mirroring the RFC 8414 §3.3 "one narrow tolerance" applied at metadata-echo
 * validation in {@linkcode discoverAuthorizationServerMetadata}: when the SDK
 * derives an issuer from `String(new URL(...))` (always slash-suffixed) and the AS
 * publishes a slash-free `metadata.issuer`, the two name the same authorization
 * server. Also the comparison behind {@linkcode OAuthClientProvider.trustedAuthorizationServers}
 * entry matching.
 */
function issuersMatch(a: string, b: string): boolean {
    return a === b || (a.endsWith('/') && a.slice(0, -1) === b) || (b.endsWith('/') && b.slice(0, -1) === a);
}

/**
 * Type guard distinguishing `OAuthClientProvider` from a minimal `AuthProvider`.
 * Transports use this at construction time to classify the `authProvider` option.
 *
 * Checks for `tokens()` + `clientInformation()` — two required `OAuthClientProvider`
 * methods that a minimal `AuthProvider` `{ token: ... }` would never have.
 */
export function isOAuthClientProvider(provider: AuthProvider | OAuthClientProvider | undefined): provider is OAuthClientProvider {
    if (provider == null) return false;
    const p = provider as OAuthClientProvider;
    return typeof p.tokens === 'function' && typeof p.clientInformation === 'function';
}

/**
 * Standard `onUnauthorized` behavior for OAuth providers: extracts
 * `WWW-Authenticate` parameters from the 401 response and runs {@linkcode auth}.
 * Used by {@linkcode adaptOAuthProvider} to bridge `OAuthClientProvider` to `AuthProvider`.
 */
export async function handleOAuthUnauthorized(
    provider: OAuthClientProvider,
    ctx: UnauthorizedContext,
    extraAuthOptions?: Pick<AuthOptions, 'skipIssuerMetadataValidation'>
): Promise<void> {
    const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(ctx.response);
    const result = await auth(provider, {
        serverUrl: ctx.serverUrl,
        resourceMetadataUrl,
        // Relayed from the challenge: a URL-policy rejection falls back to the
        // well-known derivation instead of failing the flow — see
        // {@linkcode ResourceMetadataUrlSource}.
        resourceMetadataUrlSource: 'www-authenticate',
        scope,
        fetchFn: ctx.fetchFn,
        ...extraAuthOptions
    });
    if (result !== 'AUTHORIZED') {
        throw new UnauthorizedError();
    }
}

/**
 * Adapts an `OAuthClientProvider` to the minimal `AuthProvider` interface that
 * transports consume. Called once at transport construction — the transport stores
 * the adapted provider for `_commonHeaders()` and 401 handling, while keeping the
 * original `OAuthClientProvider` for OAuth-specific paths (`finishAuth()`, 403 `insufficient_scope` step-up).
 *
 * SEP-2352 note: `token()` here is the per-request `Authorization: Bearer …` read for
 * the *resource server* (the MCP transport URL), not an authorization server. No OAuth
 * discovery has run at this layer, so there is no `issuer` to pass as `ctx` and no
 * {@linkcode discardIfIssuerMismatch} check to apply — the access token is sent only to
 * the resource server, never to an AS, so the SEP-2352 cross-AS isolation invariant is
 * not in scope. Providers that key storage on `ctx.issuer` MUST treat `ctx === undefined`
 * as "return the most-recently-saved token set" (the only consumer is the resource server
 * the token was minted for); providers that round-trip a single blob need no change.
 */
export function adaptOAuthProvider(
    provider: OAuthClientProvider,
    extraAuthOptions?: Pick<AuthOptions, 'skipIssuerMetadataValidation'>
): AuthProvider {
    return {
        token: async () => {
            const tokens = await provider.tokens();
            return tokens?.access_token;
        },
        onUnauthorized: async ctx => handleOAuthUnauthorized(provider, ctx, extraAuthOptions)
    };
}

/**
 * Implements an end-to-end OAuth client to be used with one MCP server.
 *
 * This client relies upon a concept of an authorized "session," the exact
 * meaning of which is application-defined. Tokens, authorization codes, and
 * code verifiers should not cross different sessions.
 *
 * Transports accept `OAuthClientProvider` directly via the `authProvider` option —
 * they adapt it to {@linkcode AuthProvider} internally via {@linkcode adaptOAuthProvider}.
 * No changes are needed to existing implementations.
 */
export interface OAuthClientProvider {
    /**
     * The URL to redirect the user agent to after authorization.
     * Return `undefined` for non-interactive flows that don't require user interaction
     * (e.g., `client_credentials`, `jwt-bearer`).
     */
    get redirectUrl(): string | URL | undefined;

    /**
     * External URL the server should use to fetch client metadata document
     */
    clientMetadataUrl?: string;

    /**
     * Metadata about this OAuth client.
     */
    get clientMetadata(): OAuthClientMetadata;

    /**
     * Returns an OAuth2 state parameter.
     */
    state?(): string | Promise<string>;

    /**
     * Loads information about this OAuth client, as registered already with the
     * server, or returns `undefined` if the client is not registered with the
     * server.
     *
     * @param ctx - Carries the resolved authorization-server `issuer`. Providers
     *   that persist credentials per authorization server should return the entry
     *   keyed by `ctx.issuer`. Providers with a single credential set may ignore it.
     */
    clientInformation(
        ctx?: OAuthClientInformationContext
    ): StoredOAuthClientInformation | undefined | Promise<StoredOAuthClientInformation | undefined>;

    /**
     * If implemented, this permits the OAuth client to dynamically register with
     * the server. Client information saved this way should later be read via
     * {@linkcode OAuthClientProvider.clientInformation | clientInformation()}.
     *
     * This method is not required to be implemented if client information is
     * statically known (e.g., pre-registered).
     *
     * @param ctx - Carries the resolved authorization-server `issuer`. Providers
     *   that persist credentials per authorization server should store the entry
     *   keyed by `ctx.issuer`.
     */
    saveClientInformation?(clientInformation: StoredOAuthClientInformation, ctx?: OAuthClientInformationContext): void | Promise<void>;

    /**
     * Loads any existing OAuth tokens for the current session, or returns
     * `undefined` if there are no saved tokens.
     *
     * @param ctx - Carries the resolved authorization-server `issuer`. Providers
     *   that persist tokens per authorization server should return the entry
     *   keyed by `ctx.issuer`. Providers with a single token set may ignore it.
     *   When called with no `ctx` — the transport's per-request bearer-token
     *   read — return the most-recently-saved token set; do not return
     *   `undefined` for `ctx === undefined`.
     */
    tokens(ctx?: OAuthClientInformationContext): StoredOAuthTokens | undefined | Promise<StoredOAuthTokens | undefined>;

    /**
     * Stores new OAuth tokens for the current session, after a successful
     * authorization.
     *
     * @param ctx - Carries the resolved authorization-server `issuer`. Providers
     *   that persist tokens per authorization server should store the entry
     *   keyed by `ctx.issuer`.
     */
    saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext): void | Promise<void>;

    /**
     * Invoked to redirect the user agent to the given URL to begin the authorization flow.
     */
    redirectToAuthorization(authorizationUrl: URL): void | Promise<void>;

    /**
     * Saves a PKCE code verifier for the current session, before redirecting to
     * the authorization flow.
     */
    saveCodeVerifier(codeVerifier: string): void | Promise<void>;

    /**
     * Loads the PKCE code verifier for the current session, necessary to validate
     * the authorization result.
     */
    codeVerifier(): string | Promise<string>;

    /**
     * Adds custom client authentication to OAuth token requests.
     *
     * This optional method allows implementations to customize how client credentials
     * are included in token exchange and refresh requests. When provided, this method
     * is called instead of the default authentication logic, giving full control over
     * the authentication mechanism.
     *
     * Common use cases include:
     * - Supporting authentication methods beyond the standard OAuth 2.0 methods
     * - Adding custom headers for proprietary authentication schemes
     * - Implementing client assertion-based authentication (e.g., JWT bearer tokens)
     *
     * @param headers - The request headers (can be modified to add authentication)
     * @param params - The request body parameters (can be modified to add credentials)
     * @param url - The token endpoint URL being called
     * @param metadata - Optional OAuth metadata for the server, which may include supported authentication methods
     */
    addClientAuthentication?: AddClientAuthentication;

    /**
     * If defined, overrides the selection and validation of the
     * RFC 8707 Resource Indicator. If left undefined, default
     * validation behavior will be used.
     *
     * Implementations must verify the returned resource matches the MCP server.
     */
    validateResourceURL?(serverUrl: string | URL, resource?: string): Promise<URL | undefined>;

    /**
     * Trust verification hook for every URL the OAuth flow validates: called AFTER
     * a URL has passed the SDK's own URL policy ({@linkcode assertAllowedDiscoveryUrl}),
     * at every checkpoint —
     *
     * - before each request the flow issues (discovery GETs, token and registration
     *   POSTs), including each manually-followed redirect `Location` target
     *   (`ctx.purpose === 'redirect-hop'`), and
     * - at the assert-only sites where a URL is adopted rather than requested:
     *   authorization-server adoption per RFC 9728 §7.6 (fresh discovery, the legacy
     *   server-derived fallback, and restore from cached discovery state — the
     *   context's `source` says which) and the authorization endpoint the user agent
     *   is about to be redirected to.
     *
     * Filter on `ctx.purpose`/`ctx.source` to scope a check to specific steps.
     * Throw to reject the URL and fail the flow closed; return normally to accept
     * it. A rejection always surfaces to callers as
     * {@linkcode DiscoveryUrlBlockedError} — a throw of any other type is wrapped
     * (with the original error as `cause`), so there is a single failure type for
     * every URL-policy or trust rejection. The SDK's mechanical policy checks URL
     * structure and locality only — implement this hook (or
     * {@linkcode OAuthClientProvider.trustedAuthorizationServers | trustedAuthorizationServers})
     * to verify the URLs the flow contacts are ones the application trusts.
     */
    validateDiscoveryURL?(ctx: DiscoveryUrlContext): void | Promise<void>;

    /**
     * Declarative RFC 9728 §7.6 trust list for authorization servers. Entries are
     * issuer identifiers: an adopted authorization server must match an entry on the
     * full identifier, tolerating only a trailing-slash difference. A
     * path-distinguished issuer (e.g. `https://as.example.com/tenant1`) is matched
     * exactly — listing one tenant does not trust another on the same host, and an
     * origin-only entry does not cover pathed issuers on that host. The list is
     * exhaustive, not additive: an authorization server matching no entry is rejected
     * with {@linkcode DiscoveryUrlBlockedError}, even when it passes every other rule.
     * This includes the legacy fallback where the MCP server acts as its own
     * authorization server — list the server's base URL to allow that arrangement.
     *
     * The list is enforced where the flow adopts an authorization server
     * (`auth()` and the transports, including restore from cached discovery
     * state). {@linkcode fetchToken} takes a caller-supplied authorization
     * server and adopts nothing, so it does not consult the list — on that path
     * only the {@linkcode OAuthClientProvider.validateDiscoveryURL | validateDiscoveryURL}
     * hook runs, at the token-endpoint checkpoint.
     */
    trustedAuthorizationServers?: (string | URL)[];

    /**
     * Overrides for the URL policy applied to every discovery-derived URL before
     * it is requested or adopted ({@linkcode assertAllowedDiscoveryUrl}) — see
     * {@linkcode DiscoveryUrlPolicyOptions} for what each option relaxes. All
     * options are **policy-weakening** and default to off (the policy fails
     * closed); rejection messages name the option that would have permitted the
     * URL.
     *
     * This member is the durable home for a deployment's policy: every flow the
     * SDK drives with this provider — including the flows the client transports
     * run on `401`/`403` challenges and on `finishAuth` — reads it. A per-call
     * {@linkcode AuthOptions.discoveryPolicy} takes precedence when both are
     * set; the effective policy is resolved once at flow entry.
     */
    readonly discoveryPolicy?: DiscoveryUrlPolicyOptions;

    /**
     * If implemented, provides a way for the client to invalidate (e.g. delete) the specified
     * credentials, in the case where the server has indicated that they are no longer valid.
     * This avoids requiring the user to intervene manually.
     */
    invalidateCredentials?(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void | Promise<void>;

    /**
     * Prepares grant-specific parameters for a token request.
     *
     * This optional method allows providers to customize the token request based on
     * the grant type they support. When implemented, it returns the grant type and
     * any grant-specific parameters needed for the token exchange.
     *
     * If not implemented, the default behavior depends on the flow:
     * - For authorization code flow: uses `code`, `code_verifier`, and `redirect_uri`
     * - For `client_credentials`: detected via `grant_types` in {@linkcode OAuthClientProvider.clientMetadata | clientMetadata}
     *
     * @param scope - Optional scope to request
     * @returns Grant type and parameters, or `undefined` to use default behavior
     *
     * @example
     * // For client_credentials grant:
     * prepareTokenRequest(scope) {
     *   return {
     *     grantType: 'client_credentials',
     *     params: scope ? { scope } : {}
     *   };
     * }
     *
     * @example
     * // For authorization_code grant (default behavior):
     * async prepareTokenRequest() {
     *   return {
     *     grantType: 'authorization_code',
     *     params: {
     *       code: this.authorizationCode,
     *       code_verifier: await this.codeVerifier(),
     *       redirect_uri: String(this.redirectUrl)
     *     }
     *   };
     * }
     */
    prepareTokenRequest?(scope?: string): URLSearchParams | Promise<URLSearchParams | undefined> | undefined;

    /**
     * Saves the resolved authorization-server **issuer**. Called after a successful
     * token exchange (timing changed in v2: was post-discovery, now post-`saveTokens`).
     *
     * @deprecated Superseded by the `issuer` stamp on stored tokens / client credentials
     * (SEP-2352). {@linkcode auth} still **writes** this for back-compat with providers
     * that read it (e.g. Cross-App Access), but the SDK never reads it. Prefer reading
     * the `issuer` field on the value passed to {@linkcode saveTokens} /
     * {@linkcode saveClientInformation}, or the `ctx.issuer` argument.
     */
    saveAuthorizationServerUrl?(authorizationServerUrl: string): void | Promise<void>;

    /**
     * Returns the previously saved authorization server URL, if available.
     *
     * @deprecated Superseded by the `issuer` stamp on stored tokens / client credentials
     * (SEP-2352). The SDK never reads this method; it remains for provider implementations
     * that consume the value internally (e.g. Cross-App Access).
     */
    authorizationServerUrl?(): string | undefined | Promise<string | undefined>;

    /**
     * Saves the resource URL after RFC 9728 discovery.
     * This method is called by {@linkcode auth} after successful discovery of the
     * resource metadata.
     *
     * Providers implementing Cross-App Access or other flows that need access to
     * the discovered resource URL should implement this method.
     *
     * @param resourceUrl - The resource URL discovered via RFC 9728
     */
    saveResourceUrl?(resourceUrl: string): void | Promise<void>;

    /**
     * Returns the previously saved resource URL, if available.
     *
     * Providers implementing Cross-App Access can use this to access the
     * resource URL discovered during the OAuth flow.
     *
     * @returns The resource URL, or `undefined` if not available
     */
    resourceUrl?(): string | undefined | Promise<string | undefined>;

    /**
     * Saves the OAuth discovery state after RFC 9728 and authorization server metadata
     * discovery. Providers can persist this state to avoid redundant discovery requests
     * on subsequent {@linkcode auth} calls.
     *
     * This state can also be provided out-of-band (e.g., from a previous session or
     * external configuration) to bootstrap the OAuth flow without discovery.
     *
     * Called by {@linkcode auth} after successful discovery.
     *
     * MUST persist with the same durability as `codeVerifier` (survives the redirect
     * round-trip).
     */
    saveDiscoveryState?(state: OAuthDiscoveryState): void | Promise<void>;

    /**
     * Returns previously saved discovery state, or `undefined` if none is cached.
     *
     * When available, {@linkcode auth} restores the discovery state (authorization server
     * URL, resource metadata, etc.) instead of performing RFC 9728 discovery, reducing
     * latency on subsequent calls.
     *
     * Hosts should call {@linkcode invalidateCredentials} with scope `'discovery'`
     * on repeated 401s so a changed `authorization_servers` list is picked up; the
     * SDK does not invoke that scope itself.
     *
     * MUST persist with the same durability as `codeVerifier` (survives the redirect
     * round-trip).
     */
    discoveryState?(): OAuthDiscoveryState | undefined | Promise<OAuthDiscoveryState | undefined>;
}

/**
 * Discovery state that can be persisted across sessions by an {@linkcode OAuthClientProvider}.
 *
 * Contains the results of RFC 9728 protected resource metadata discovery and
 * authorization server metadata discovery. Persisting this state avoids
 * redundant discovery HTTP requests on subsequent {@linkcode auth} calls.
 */
// TODO: Consider adding `authorizationServerMetadataUrl` to capture the exact well-known URL
// at which authorization server metadata was discovered. This would require
// `discoverAuthorizationServerMetadata()` to return the successful discovery URL.
export interface OAuthDiscoveryState extends OAuthServerInfo {
    /** The URL at which the protected resource metadata was found, if available. */
    resourceMetadataUrl?: string;
}

export type AuthResult = 'AUTHORIZED' | 'REDIRECT';

/**
 * Provenance of an explicitly-supplied protected-resource-metadata URL
 * ({@linkcode AuthOptions.resourceMetadataUrl}). It decides how a URL-policy
 * rejection of that URL is handled:
 *
 * - `'www-authenticate'` — relayed from a server's `WWW-Authenticate` challenge
 *   (the transports label the URLs they extract this way). A rejected URL is
 *   ignored with a warning and discovery falls back to the SDK's own same-origin
 *   well-known derivation (RFC 9728 §3): non-conformant relayed input does not
 *   take the flow down when the SDK can derive the metadata location itself.
 * - `'caller'` (the default) — configured by the application. A rejected URL is a
 *   configuration statement the policy contradicts, so the flow fails closed with
 *   {@linkcode DiscoveryUrlBlockedError} instead of silently discovering at a
 *   different location. A URL restored from a provider's persisted
 *   {@linkcode OAuthDiscoveryState} is handled the same way: it is re-validated
 *   on every restore and a rejection fails closed.
 */
export type ResourceMetadataUrlSource = Extract<DiscoveryUrlSource, 'www-authenticate' | 'caller'>;

export class UnauthorizedError extends Error {
    static {
        Object.defineProperty(this, 'mcpBrand', { value: 'mcp.UnauthorizedError' });
    }

    static override [Symbol.hasInstance](value: unknown): boolean {
        return brandedHasInstance(this, value);
    }

    /**
     * Brand-based type guard: equivalent to `value instanceof this`, as an
     * explicit static predicate (the axios/AWS-SDK `isInstance` style). Reads
     * the caller's own brand via `this`, so every branded subclass gets a
     * correctly-scoped guard by inheritance. Must be invoked on the class —
     * in callback position write `v => SdkError.isInstance(v)`, not
     * `.filter(SdkError.isInstance)` (detached calls throw rather than
     * silently matching nothing).
     */
    static isInstance<T extends abstract new (...args: never[]) => unknown>(this: T, value: unknown): value is InstanceType<T> {
        if (typeof this !== 'function') {
            throw new TypeError(
                'isInstance must be called on the class (e.g. `SdkError.isInstance(value)`); for callbacks use `v => SdkError.isInstance(v)`'
            );
        }
        return brandedHasInstance(this, value);
    }

    constructor(message?: string) {
        super(message ?? 'Unauthorized');
        this.name = 'UnauthorizedError';
        stampErrorBrands(this, new.target);
    }
}

/**
 * Validates the `iss` parameter from an authorization response against the
 * issuer recorded from the authorization server's validated metadata, per
 * RFC 9207 §2.4 and the MCP specification's four-row decision table.
 *
 * | `issParameterSupported` | `iss`   | Action                                           |
 * | ----------------------- | ------- | ------------------------------------------------ |
 * | `true`                  | present | compare; throw {@linkcode IssuerMismatchError} on mismatch |
 * | `true`                  | absent  | throw {@linkcode IssuerMismatchError}            |
 * | `false`                 | present | compare; throw {@linkcode IssuerMismatchError} on mismatch |
 * | `false`                 | absent  | proceed (no-op)                                  |
 *
 * Comparison is **simple string equality** (RFC 3986 §6.2.1). Scheme/host case
 * folding, default-port elision, trailing-slash, and percent-encoding
 * normalization are explicitly **not** applied — any difference is a mismatch.
 *
 * When `expectedIssuer` is `undefined` (no validated metadata document exists),
 * the check has no authentic baseline and degenerates to a no-op.
 *
 * @throws {IssuerMismatchError} with `kind: 'authorization_response'`
 */
/**
 * Reads RFC 9207's `authorization_response_iss_parameter_supported` from
 * authorization-server metadata. Only a literal `true` counts as advertised;
 * absent, `false`, or a non-boolean wire value (coerced to `undefined` by the
 * schema) means not advertised.
 */
function isIssParameterSupported(metadata: AuthorizationServerMetadata | undefined): boolean {
    return metadata?.authorization_response_iss_parameter_supported === true;
}

export function validateAuthorizationResponseIssuer({
    iss,
    expectedIssuer,
    issParameterSupported
}: {
    /** The form-urldecoded `iss` query parameter from the authorization callback, or `undefined` if absent. */
    iss: string | undefined;
    /** The `issuer` value from the authorization server's validated metadata document. */
    expectedIssuer: string | undefined;
    /** Whether the metadata advertised `authorization_response_iss_parameter_supported: true`. */
    issParameterSupported: boolean;
}): void {
    if (expectedIssuer === undefined) {
        // No validated metadata document → no recorded issuer → no comparison (table row 4).
        return;
    }
    if (iss === undefined) {
        if (issParameterSupported) {
            // Row 2: AS advertised that it always sends `iss`; absence is a stripped-parameter attack indicator.
            throw new IssuerMismatchError('authorization_response', expectedIssuer, undefined);
        }
        // Row 4: not advertised, not present → proceed.
        return;
    }
    // Rows 1 & 3: present → compare with simple string comparison only.
    if (iss !== expectedIssuer) {
        throw new IssuerMismatchError('authorization_response', expectedIssuer, iss);
    }
}

/**
 * Computes the union of one or more OAuth `scope` strings.
 *
 * Each argument is a space-delimited scope string per RFC 6749 §3.3, or
 * `undefined`. The result is a single space-delimited string containing each
 * distinct scope token exactly once, in first-seen order, or `undefined` if
 * every input is empty/undefined.
 *
 * No hierarchical deduplication is performed: a union may contain semantically
 * redundant entries (e.g., a broad scope alongside a narrower one it implies).
 * Authorization servers normalize such redundancy during token issuance; the
 * spec's step-up flow does not require clients to.
 *
 * Used by the transport's `403 insufficient_scope` step-up path to accumulate
 * previously-requested scopes with newly-challenged scopes so re-authorization
 * does not lose previously-granted permissions.
 */
export function computeScopeUnion(...scopes: ReadonlyArray<string | undefined>): string | undefined {
    const seen = new Set<string>();
    for (const scope of scopes) {
        if (!scope) continue;
        for (const token of scope.split(/\s+/)) {
            if (token) seen.add(token);
        }
    }
    return seen.size > 0 ? [...seen].join(' ') : undefined;
}

/**
 * Whether `union` contains at least one scope token not present in `current`.
 * Both arguments are space-delimited scope strings per RFC 6749 §3.3.
 *
 * Used to gate the step-up refresh bypass: when the union of previously-requested
 * and newly-challenged scopes is a strict superset of the current token's
 * granted scope, refreshing cannot widen the grant (RFC 6749 §6), so the
 * transport must force a fresh authorization request instead. When the current
 * token already covers the union, refresh remains valid.
 *
 * An undefined or empty `current` is treated as the empty set, so any non-empty
 * `union` is a strict superset. Note that per RFC 6749 §3.3 an authorization
 * server MAY omit the token's `scope` field when it equals the requested scope;
 * this helper is conservative and treats an absent token `scope` as empty, so
 * step-up always forces a fresh authorization request in that case rather than
 * risking a refresh that silently drops the widened scope.
 */
export function isStrictScopeSuperset(union: string | undefined, current: string | undefined): boolean {
    if (!union) return false;
    const currentSet = new Set((current ?? '').split(/\s+/).filter(Boolean));
    for (const token of union.split(/\s+/)) {
        if (token && !currentSet.has(token)) return true;
    }
    return false;
}

/**
 * Shared `finishAuth` resolver for the `(code, iss?)` and `(URLSearchParams)` overloads.
 *
 * For the `URLSearchParams` form, only `iss` and `code` are read up front. When a `code` is
 * present the returned values flow into {@linkcode auth}, which runs
 * {@linkcode validateAuthorizationResponseIssuer} against freshly-discovered metadata before
 * the code is redeemed — so on mismatch the thrown {@linkcode IssuerMismatchError} carries no
 * `error`/`error_description`/`error_uri` text from the callback (those are attacker-controlled
 * in a mix-up). When no `code` is present (an error-shaped callback), `iss` is validated here
 * against the provider's recorded discovery state — or, when the provider does not implement
 * `discoveryState`, against freshly-discovered metadata mirroring what {@linkcode auth} does on
 * the code-present path — **before** the callback's error parameters are read; only after that
 * passes are they surfaced as an {@linkcode OAuthError}. When no issuer baseline can be
 * obtained either way, a generic {@linkcode UnauthorizedError} is thrown without surfacing the
 * callback's `error`/`error_description`/`error_uri`.
 *
 * @internal Exported for the transport `finishAuth` overloads; not part of the public barrel.
 */
export async function resolveAuthorizationCallbackParams(
    codeOrParams: string | URLSearchParams,
    iss: string | undefined,
    provider: OAuthClientProvider,
    serverUrl: string | URL,
    opts?: {
        fetchFn?: FetchLike;
        resourceMetadataUrl?: URL;
        /** Provenance of `resourceMetadataUrl` — see {@linkcode ResourceMetadataUrlSource}. */
        resourceMetadataUrlSource?: ResourceMetadataUrlSource;
        discoveryPolicy?: DiscoveryUrlPolicyOptions;
    }
): Promise<{ authorizationCode: string; iss: string | undefined }> {
    if (typeof codeOrParams === 'string') {
        return { authorizationCode: codeOrParams, iss };
    }
    const issParam = codeOrParams.get('iss') ?? undefined;
    const code = codeOrParams.get('code');
    if (code) {
        return { authorizationCode: code, iss: issParam };
    }
    // No code → error response. Gate the (potentially attacker-supplied) error params on the
    // issuer first. Prefer the provider's recorded discovery state; when absent, mirror auth()'s
    // code-present path and run a fresh discovery so the iss gate has an authentic baseline.
    const discoveryState = await provider.discoveryState?.();
    let metadata = discoveryState?.authorizationServerMetadata;
    if (!metadata) {
        try {
            // Effective policy resolved once at this flow entry, like authInternal's;
            // the provider's RFC 9728 §7.6 trust members apply to the adoption exactly
            // as on the main flow.
            const serverInfo = await discoverOAuthServerInfoInternal(
                serverUrl,
                {
                    ...opts,
                    discoveryPolicy: opts?.discoveryPolicy ?? provider.discoveryPolicy
                },
                {
                    trustedAuthorizationServers: provider.trustedAuthorizationServers,
                    validateDiscoveryURL: provider.validateDiscoveryURL?.bind(provider)
                }
            );
            metadata = serverInfo.authorizationServerMetadata;
        } catch {
            metadata = undefined;
        }
    }
    if (!metadata) {
        // No authentic baseline → cannot prove the error params came from our AS. Do NOT surface
        // attacker-controllable `error`/`error_description`/`error_uri` here.
        throw new UnauthorizedError('Authorization callback failed and the issuer could not be verified');
    }
    validateAuthorizationResponseIssuer({
        iss: issParam,
        expectedIssuer: metadata.issuer,
        issParameterSupported: isIssParameterSupported(metadata)
    });
    const error = codeOrParams.get('error');
    if (error) {
        throw new OAuthError(error, codeOrParams.get('error_description') ?? error, codeOrParams.get('error_uri') ?? undefined);
    }
    throw new UnauthorizedError('Authorization callback contained neither `code` nor `error`');
}

export type ClientAuthMethod = 'client_secret_basic' | 'client_secret_post' | 'none';

function isClientAuthMethod(method: string): method is ClientAuthMethod {
    return ['client_secret_basic', 'client_secret_post', 'none'].includes(method);
}

const AUTHORIZATION_CODE_RESPONSE_TYPE = 'code';
const AUTHORIZATION_CODE_CHALLENGE_METHOD = 'S256';

/**
 * Determines the best client authentication method to use based on server support and client configuration.
 *
 * Priority order (highest to lowest):
 * 1. `client_secret_basic` (if client secret is available)
 * 2. `client_secret_post` (if client secret is available)
 * 3. `none` (for public clients)
 *
 * @param clientInformation - OAuth client information containing credentials
 * @param supportedMethods - Authentication methods supported by the authorization server
 * @returns The selected authentication method
 */
export function selectClientAuthMethod(clientInformation: OAuthClientInformationMixed, supportedMethods: string[]): ClientAuthMethod {
    const hasClientSecret = clientInformation.client_secret !== undefined;

    // Prefer the method returned by the server during client registration, if valid.
    // When server metadata is present we also require the method to be listed as supported;
    // when supportedMethods is empty (metadata omitted the field) the DCR hint stands alone.
    if (
        'token_endpoint_auth_method' in clientInformation &&
        clientInformation.token_endpoint_auth_method &&
        isClientAuthMethod(clientInformation.token_endpoint_auth_method) &&
        (supportedMethods.length === 0 || supportedMethods.includes(clientInformation.token_endpoint_auth_method))
    ) {
        return clientInformation.token_endpoint_auth_method;
    }

    // If server metadata omits token_endpoint_auth_methods_supported, RFC 8414 §2 says the
    // default is client_secret_basic. RFC 6749 §2.3.1 also requires servers to support HTTP
    // Basic authentication for clients with a secret, making it the safest default.
    if (supportedMethods.length === 0) {
        return hasClientSecret ? 'client_secret_basic' : 'none';
    }

    // Try methods in priority order (most secure first)
    if (hasClientSecret && supportedMethods.includes('client_secret_basic')) {
        return 'client_secret_basic';
    }

    if (hasClientSecret && supportedMethods.includes('client_secret_post')) {
        return 'client_secret_post';
    }

    if (supportedMethods.includes('none')) {
        return 'none';
    }

    // Fallback: use what we have
    return hasClientSecret ? 'client_secret_post' : 'none';
}

/**
 * Applies client authentication to the request based on the specified method.
 *
 * Implements OAuth 2.1 client authentication methods:
 * - `client_secret_basic`: HTTP Basic authentication (RFC 6749 Section 2.3.1)
 * - `client_secret_post`: Credentials in request body (RFC 6749 Section 2.3.1)
 * - `none`: Public client authentication (RFC 6749 Section 2.1)
 *
 * @param method - The authentication method to use
 * @param clientInformation - OAuth client information containing credentials
 * @param headers - HTTP headers object to modify
 * @param params - URL search parameters to modify
 * @throws {Error} When required credentials are missing
 */
export function applyClientAuthentication(
    method: ClientAuthMethod,
    clientInformation: OAuthClientInformation,
    headers: Headers,
    params: URLSearchParams
): void {
    const { client_id, client_secret } = clientInformation;

    switch (method) {
        case 'client_secret_basic': {
            applyBasicAuth(client_id, client_secret, headers);
            return;
        }
        case 'client_secret_post': {
            applyPostAuth(client_id, client_secret, params);
            return;
        }
        case 'none': {
            applyPublicAuth(client_id, params);
            return;
        }
        default: {
            throw new Error(`Unsupported client authentication method: ${method}`);
        }
    }
}

/**
 * Applies HTTP Basic authentication (RFC 6749 Section 2.3.1)
 */
export function applyBasicAuth(clientId: string, clientSecret: string | undefined, headers: Headers): void {
    if (!clientSecret) {
        throw new Error('client_secret_basic authentication requires a client_secret');
    }

    const credentials = btoa(`${clientId}:${clientSecret}`);
    headers.set('Authorization', `Basic ${credentials}`);
}

/**
 * Applies POST body authentication (RFC 6749 Section 2.3.1)
 */
export function applyPostAuth(clientId: string, clientSecret: string | undefined, params: URLSearchParams): void {
    params.set('client_id', clientId);
    if (clientSecret) {
        params.set('client_secret', clientSecret);
    }
}

/**
 * Applies public client authentication (RFC 6749 Section 2.1)
 */
export function applyPublicAuth(clientId: string, params: URLSearchParams): void {
    params.set('client_id', clientId);
}

/** Loopback hosts exempt from the in-transit `https:` requirement (RFC 8252 §7.3). */
function isLoopbackHost(hostname: string): boolean {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

/**
 * SEP-2207: refuse to send credentials to a non-TLS, non-loopback token endpoint.
 * Throws {@linkcode InsecureTokenEndpointError}. Loopback hosts are exempt.
 */
export function assertSecureTokenEndpoint(tokenEndpoint: string | URL): URL {
    const url = new URL(String(tokenEndpoint));
    if (url.protocol !== 'https:' && !isLoopbackHost(url.hostname)) {
        throw new InsecureTokenEndpointError(url.href);
    }
    return url;
}

/**
 * Derives an OIDC `application_type` from a client's registered redirect URIs
 * when the consumer has not set one explicitly (SEP-837). Loopback hosts and
 * non-`http(s)` custom URI schemes indicate a native application (RFC 8252);
 * everything else is treated as a web application. The result is a heuristic
 * default — callers that know better should set `clientMetadata.application_type`
 * themselves, which {@linkcode resolveClientMetadata} never overwrites.
 *
 * A mixed redirect set (for example a public `https:` URI alongside a loopback
 * URI) is inherently ambiguous under OIDC DCR §2 — neither value satisfies the
 * AS for both URIs — so consumers with mixed sets should set `application_type`
 * explicitly rather than relying on this heuristic.
 */
function deriveApplicationType(redirectUris: readonly string[] | undefined): 'native' | 'web' {
    for (const raw of redirectUris ?? []) {
        let url: URL;
        try {
            url = new URL(raw);
        } catch {
            continue;
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'native';
        if (isLoopbackHost(url.hostname)) return 'native';
    }
    return 'web';
}

/**
 * Reads {@linkcode OAuthClientProvider.clientMetadata | clientMetadata} from the
 * provider and fills the SEP-837 / SEP-2207 defaults the SDK relies on, so
 * {@linkcode registerClient} sees a consistent, fully-populated document.
 *
 * - `grant_types` defaults to `['authorization_code', 'refresh_token']` for
 *   interactive providers (those with a {@linkcode OAuthClientProvider.redirectUrl | redirectUrl})
 *   so authorization servers that gate refresh-token issuance on the registered
 *   grant types issue one (SEP-2207). Non-interactive providers (no
 *   `redirectUrl`) get no `grant_types` default. This default applies to the
 *   Dynamic Client Registration body only — it does **not** drive
 *   {@linkcode determineScope}'s `offline_access` augmentation.
 * - `application_type` defaults from `redirect_uris`: loopback redirect hosts
 *   and custom URI schemes → `'native'`, otherwise `'web'` (SEP-837 / RFC 8252).
 *
 * A field the consumer set explicitly is **never** overwritten. {@linkcode auth}
 * calls this once at the top of the flow; direct callers of
 * {@linkcode registerClient} that want the same defaults should pass the result
 * of this function as `clientMetadata`.
 */
export function resolveClientMetadata(provider: Pick<OAuthClientProvider, 'clientMetadata' | 'redirectUrl'>): OAuthClientMetadata {
    const clientMetadata = provider.clientMetadata;
    return {
        ...clientMetadata,
        grant_types:
            clientMetadata.grant_types ?? (provider.redirectUrl === undefined ? undefined : ['authorization_code', 'refresh_token']),
        application_type: clientMetadata.application_type ?? deriveApplicationType(clientMetadata.redirect_uris)
    };
}

/**
 * Parses an OAuth error response from a string or Response object.
 *
 * If the input is a standard OAuth2.0 error response, it will be parsed according to the spec
 * and an {@linkcode OAuthError} will be returned with the appropriate error code.
 * If parsing fails, it falls back to a generic {@linkcode OAuthErrorCode.ServerError | ServerError} that includes
 * the response status (if available) and original content.
 *
 * @param input - A Response object or string containing the error response
 * @returns A Promise that resolves to an {@linkcode OAuthError} instance
 */
export async function parseErrorResponse(input: Response | string): Promise<OAuthError> {
    const statusCode = input instanceof Response ? input.status : undefined;
    const body = input instanceof Response ? await input.text() : input;

    try {
        const result = OAuthErrorResponseSchema.parse(JSON.parse(body));
        return OAuthError.fromResponse(result);
    } catch (error) {
        // Not a valid OAuth error response, but try to inform the user of the raw data anyway
        const errorMessage = `${statusCode ? `HTTP ${statusCode}: ` : ''}Invalid OAuth error response: ${error}. Raw body: ${body}`;
        return new OAuthError(OAuthErrorCode.ServerError, errorMessage);
    }
}

/**
 * Options for {@linkcode auth}. The full OAuth flow orchestrator's input.
 */
export interface AuthOptions {
    /** The MCP server URL — the protected resource the flow authorizes against. */
    serverUrl: string | URL;
    /**
     * The authorization code returned by the authorization server on the redirect
     * callback. When set, {@linkcode auth} exchanges it for tokens; when unset,
     * {@linkcode auth} runs discovery and either refreshes or initiates redirect.
     */
    authorizationCode?: string;
    /**
     * The form-urldecoded `iss` query parameter from the authorization callback,
     * if present. Passed through to RFC 9207 §2.4 issuer validation alongside
     * `authorizationCode`. Validated against the recorded issuer per RFC 9207
     * §2.4 before the code is redeemed — see
     * {@linkcode validateAuthorizationResponseIssuer} and the migration guide's
     * *Authorization-server mix-up defense* section.
     */
    iss?: string;
    /** Scope to request; computed by Scope Selection Strategy when omitted. */
    scope?: string;
    /**
     * Explicit protected-resource-metadata URL, bypassing the RFC 9728 §3
     * well-known derivation. Callers relaying a `WWW-Authenticate` challenge's
     * `resource_metadata` value should also set
     * {@linkcode AuthOptions.resourceMetadataUrlSource | resourceMetadataUrlSource}.
     */
    resourceMetadataUrl?: URL;
    /**
     * Where `resourceMetadataUrl` came from — see
     * {@linkcode ResourceMetadataUrlSource} for how each value handles a
     * URL-policy rejection. Callers relaying a `WWW-Authenticate` challenge
     * (as the SDK transports do) set `'www-authenticate'`; the default
     * `'caller'` treats a rejected URL as a configuration error and fails
     * closed.
     */
    resourceMetadataUrlSource?: ResourceMetadataUrlSource;
    /** Custom `fetch` implementation. */
    fetchFn?: FetchLike;
    /**
     * Overrides for the URL policy applied to every discovery-derived URL before it
     * is requested or adopted ({@linkcode assertAllowedDiscoveryUrl}). All options
     * are **policy-weakening** and default to off. Takes precedence over
     * {@linkcode OAuthClientProvider.discoveryPolicy} when both are set; the
     * effective policy is resolved once at flow entry.
     */
    discoveryPolicy?: DiscoveryUrlPolicyOptions;
    /**
     * Opt-out for the RFC 8414 §3.3 issuer-echo check during authorization
     * server discovery. Disabling it is **security-weakening** and intended only
     * for authorization servers known to publish a mismatched `issuer`.
     *
     * @default false
     */
    skipIssuerMetadataValidation?: boolean;
    /**
     * When `true`, {@linkcode auth} skips the refresh-token branch even when a
     * `refresh_token` is available, and proceeds directly to a fresh
     * authorization request ({@linkcode startAuthorization}).
     *
     * Set by the transport's `403 insufficient_scope` step-up path when the
     * required scope is a strict superset of the current token's granted scope:
     * the refresh grant cannot widen scope (RFC 6749 §6), so refreshing would
     * silently drop the new scope and the next request would 403 again. Forcing
     * a fresh authorization request ensures the widened scope reaches the
     * authorization server.
     *
     * Hosts driving step-up themselves (with `onInsufficientScope: 'throw'`)
     * should set this when {@linkcode isStrictScopeSuperset} of the union over
     * the current token's `scope` is `true`.
     *
     * @default false
     */
    forceReauthorization?: boolean;
}

/**
 * Orchestrates the full auth flow with a server.
 *
 * This can be used as a single entry point for all authorization functionality,
 * instead of linking together the other lower-level functions in this module.
 */
export async function auth(provider: OAuthClientProvider, options: AuthOptions): Promise<AuthResult> {
    try {
        return await authInternal(provider, options);
    } catch (error) {
        // Handle recoverable error types by invalidating credentials and retrying
        if (error instanceof OAuthError) {
            if (error.code === OAuthErrorCode.InvalidClient || error.code === OAuthErrorCode.UnauthorizedClient) {
                // Not 'all' — preserve discoveryState so the callback-leg gate on retry doesn't
                // fire a false 'discoveryState was not available on the callback leg' AuthorizationServerMismatchError that masks the
                // real invalid_client.
                await provider.invalidateCredentials?.('client');
                await provider.invalidateCredentials?.('tokens');
                return await authInternal(provider, options);
            } else if (error.code === OAuthErrorCode.InvalidGrant) {
                await provider.invalidateCredentials?.('tokens');
                return await authInternal(provider, options);
            }
        }

        // Throw otherwise
        throw error;
    }
}

/**
 * Selects scopes per the MCP spec and augment for refresh token support.
 */
export function determineScope(options: {
    requestedScope?: string;
    resourceMetadata?: OAuthProtectedResourceMetadata;
    authServerMetadata?: AuthorizationServerMetadata;
    clientMetadata: OAuthClientMetadata;
}): string | undefined {
    const { requestedScope, resourceMetadata, authServerMetadata, clientMetadata } = options;

    // Scope selection priority (MCP spec):
    //   1. WWW-Authenticate header scope
    //   2. PRM scopes_supported
    //   3. clientMetadata.scope (SDK fallback)
    //   4. Omit scope parameter
    let effectiveScope = requestedScope || resourceMetadata?.scopes_supported?.join(' ') || clientMetadata.scope;

    // SEP-2207: Append offline_access when the AS advertises it and the client
    // supports the refresh_token grant. Gated on consumer-supplied grant_types;
    // SDK DCR default intentionally NOT applied here so statically-registered/CIMD
    // clients are not pushed into offline_access + prompt=consent.
    if (
        effectiveScope &&
        authServerMetadata?.scopes_supported?.includes('offline_access') &&
        !effectiveScope.split(' ').includes('offline_access') &&
        clientMetadata.grant_types?.includes('refresh_token')
    ) {
        effectiveScope = `${effectiveScope} offline_access`;
    }

    return effectiveScope;
}

async function authInternal(
    provider: OAuthClientProvider,
    {
        serverUrl,
        authorizationCode,
        iss,
        scope,
        resourceMetadataUrl,
        resourceMetadataUrlSource,
        fetchFn,
        discoveryPolicy: discoveryPolicyOverride,
        skipIssuerMetadataValidation,
        forceReauthorization
    }: AuthOptions
): Promise<AuthResult> {
    // The effective URL policy for the whole flow, resolved once at entry:
    // per-call options take precedence over the provider's durable policy.
    const discoveryPolicy = discoveryPolicyOverride ?? provider.discoveryPolicy;

    // RFC 9728 §7.6 trust, resolved once at entry. Trust flows only from the
    // provider — there is no per-call override.
    const trust: AuthorizationServerTrust = {
        trustedAuthorizationServers: provider.trustedAuthorizationServers,
        validateDiscoveryURL: provider.validateDiscoveryURL?.bind(provider)
    };

    // SEP-837 / SEP-2207: resolve spec defaults for the DCR body. determineScope()
    // intentionally reads the raw provider.clientMetadata instead.
    const clientMetadata = resolveClientMetadata(provider);

    // Check if the provider has cached discovery state to skip discovery
    const cachedState = await provider.discoveryState?.();

    let resourceMetadata: OAuthProtectedResourceMetadata | undefined;
    let authorizationServerUrl: string | URL;
    let metadata: AuthorizationServerMetadata | undefined;
    let freshDiscoveryState: OAuthDiscoveryState | undefined;

    // If resourceMetadataUrl is not provided, try to load it from cached state.
    // This handles browser redirects where the URL was saved before navigation.
    // A URL restored from cache is handled like a caller-configured one: it is
    // re-validated on every restore and a policy rejection fails closed rather
    // than discovering at a different location.
    let effectiveResourceMetadataUrl = resourceMetadataUrl;
    let effectiveResourceMetadataUrlSource = resourceMetadataUrlSource ?? 'caller';
    if (!effectiveResourceMetadataUrl && cachedState?.resourceMetadataUrl) {
        effectiveResourceMetadataUrl = new URL(cachedState.resourceMetadataUrl);
        effectiveResourceMetadataUrlSource = 'caller';
    }

    // Only a caller-configured metadata URL is recorded in discovery state (a
    // configuration statement, restored and re-validated as such above). A
    // challenge-relayed URL is re-extracted from each 401 — and may have been
    // set aside in favor of the SDK's own well-known derivation (see
    // discoverMetadataWithFallback) — so recording it could persist a URL the
    // flow never used and that a restore would then treat as caller-configured.
    const persistedResourceMetadataUrl =
        effectiveResourceMetadataUrlSource === 'caller' ? effectiveResourceMetadataUrl?.toString() : undefined;

    if (cachedState?.authorizationServerUrl) {
        // Restore discovery state from cache. The cached authorization server URL is
        // network-derived state, so it is re-validated on every restore exactly like a
        // fresh adoption — otherwise state persisted before a policy or trust-list
        // change would keep bypassing RFC 9728 §7.6 verification. A rejected cached
        // URL throws DiscoveryUrlBlockedError.
        authorizationServerUrl = cachedState.authorizationServerUrl;
        const cachedUrlContext: DiscoveryUrlContext = {
            purpose: 'authorization-server',
            url: new URL(authorizationServerUrl),
            producer: { url: new URL(serverUrl), kind: 'mcp-server' },
            source: 'cached-discovery-state'
        };
        assertAllowedDiscoveryUrl(cachedUrlContext, discoveryPolicy);
        await verifyAuthorizationServerTrust(cachedUrlContext, trust);
        resourceMetadata = cachedState.resourceMetadata;
        metadata =
            cachedState.authorizationServerMetadata ??
            (await discoverAuthorizationServerMetadataInternal(
                authorizationServerUrl,
                {
                    fetchFn,
                    skipIssuerValidation: skipIssuerMetadataValidation,
                    discoveryPolicy
                },
                trust.validateDiscoveryURL
            ));

        // If resource metadata wasn't cached, try to fetch it for selectResourceURL
        if (!resourceMetadata) {
            try {
                resourceMetadata = await discoverOAuthProtectedResourceMetadataInternal(
                    serverUrl,
                    {
                        resourceMetadataUrl: effectiveResourceMetadataUrl,
                        resourceMetadataUrlSource: effectiveResourceMetadataUrlSource,
                        discoveryPolicy
                    },
                    fetchFn,
                    trust.validateDiscoveryURL
                );
            } catch (error) {
                // Network failures (DNS, connection refused) surface as TypeError — propagate
                // those rather than masking a transient reachability problem. URL-policy
                // rejections likewise fail closed instead of proceeding without metadata, as
                // does a runtime-filtered redirect on a caller-configured metadata URL (on an
                // SDK-derived probe it degrades below, exactly like a 404).
                if (
                    error instanceof TypeError ||
                    error instanceof DiscoveryUrlBlockedError ||
                    isFilteredCallerMetadataUrl(error, effectiveResourceMetadataUrl, effectiveResourceMetadataUrlSource)
                ) {
                    throw error;
                }
                // RFC 9728 not available — selectResourceURL will handle undefined
            }
        }

        // Re-save if we enriched the cached state with missing metadata
        if (metadata !== cachedState.authorizationServerMetadata || resourceMetadata !== cachedState.resourceMetadata) {
            await provider.saveDiscoveryState?.({
                authorizationServerUrl: String(authorizationServerUrl),
                resourceMetadataUrl: persistedResourceMetadataUrl,
                resourceMetadata,
                authorizationServerMetadata: metadata
            });
        }
    } else {
        // Full discovery via RFC 9728
        const serverInfo = await discoverOAuthServerInfoInternal(
            serverUrl,
            {
                resourceMetadataUrl: effectiveResourceMetadataUrl,
                resourceMetadataUrlSource: effectiveResourceMetadataUrlSource,
                fetchFn,
                skipIssuerMetadataValidation,
                discoveryPolicy
            },
            trust
        );
        authorizationServerUrl = serverInfo.authorizationServerUrl;
        metadata = serverInfo.authorizationServerMetadata;
        resourceMetadata = serverInfo.resourceMetadata;

        // Captured now, persisted only after the SEP-2352 callback-leg gate below — so a
        // gate throw cannot leave a freshly resolved (potentially PRM-poisoned) AS recorded
        // for the retry to read back as `recordedIssuer`.
        // TODO: resourceMetadataUrl is only populated when explicitly provided via options
        // or loaded from cached state. The URL derived internally by
        // discoverOAuthProtectedResourceMetadata() is not captured back here.
        freshDiscoveryState = {
            authorizationServerUrl: String(authorizationServerUrl),
            resourceMetadataUrl: persistedResourceMetadataUrl,
            resourceMetadata,
            authorizationServerMetadata: metadata
        };
    }

    // SEP-2352: the canonical authorization-server identity for this flow. `metadata.issuer`
    // is RFC 8414 §3.3-validated to equal the discovery URL; when no metadata document was
    // found (legacy fallback) the discovery URL itself is the only identifier available.
    const issuer = metadata?.issuer ?? String(authorizationServerUrl);
    const infoCtx: OAuthClientInformationContext = { issuer };

    // Deprecated write-only hook, kept for providers (e.g. Cross-App Access) that read it
    // internally. The SDK never reads `authorizationServerUrl()`.
    await provider.saveAuthorizationServerUrl?.(issuer);

    // SEP-2352 callback-leg gate. Stored credentials are protected structurally by the
    // issuer stamp, but the in-flight `authorization_code` + PKCE `code_verifier` are not
    // stored — they are bound to the AS the redirect targeted, recorded in `discoveryState()`.
    // Fail-closed: a provider that implements saveDiscoveryState but returned no discovery
    // state on the callback leg (e.g. not persisted alongside codeVerifier across page navigation) MUST NOT
    // proceed — fresh discovery may have resolved a different AS than the one the user
    // approved at /authorize, and the clientInformation stamp alone does not protect a keyed
    // multi-AS provider here. Providers that do not implement saveDiscoveryState at all keep
    // the (legacy) warn-and-proceed behavior.
    if (authorizationCode !== undefined) {
        const recordedIssuer = cachedState?.authorizationServerMetadata?.issuer ?? cachedState?.authorizationServerUrl;
        if (recordedIssuer === undefined) {
            if (provider.saveDiscoveryState !== undefined) {
                throw new AuthorizationServerMismatchError(
                    'discoveryState was not available on the callback leg; ensure your provider persists discoveryState alongside codeVerifier',
                    issuer
                );
            }
            console.warn(
                '[mcp-sdk] OAuthClientProvider does not implement saveDiscoveryState()/discoveryState(); ' +
                    'the SEP-2352 callback-leg authorization-server binding cannot be checked. ' +
                    'Implement discoveryState (persist alongside codeVerifier) — see docs/migration/upgrade-to-v2.md §SEP-2352.'
            );
        } else if (!issuersMatch(recordedIssuer, issuer)) {
            throw new AuthorizationServerMismatchError(recordedIssuer, issuer);
        }
    }

    if (freshDiscoveryState) {
        await provider.saveDiscoveryState?.(freshDiscoveryState);
    }

    const resource: URL | undefined = await selectResourceURL(serverUrl, provider, resourceMetadata);

    // Save resource URL for providers that need it (e.g., CrossAppAccessProvider)
    if (resource) {
        await provider.saveResourceUrl?.(String(resource));
    }

    // Scope selection used consistently for DCR and the authorization request.
    const resolvedScope = determineScope({
        requestedScope: scope,
        resourceMetadata,
        authServerMetadata: metadata,
        clientMetadata: provider.clientMetadata
    });

    // Handle client registration if needed. SEP-2352: a stored credential whose `issuer`
    // stamp names a different authorization server reads back as `undefined`, so the flow
    // re-registers exactly as if nothing were stored.
    const rawClientInfo = await Promise.resolve(provider.clientInformation(infoCtx));
    let clientInformation = discardIfIssuerMismatch(rawClientInfo, issuer, {
        canPersistStamp: provider.saveClientInformation !== undefined
    });
    if (clientInformation === undefined && rawClientInfo?.issuer && provider.saveClientInformation === undefined) {
        // Static-credential provider (no DCR) whose `expectedIssuer` stamp names a different
        // AS — surface the typed error with both issuers rather than the generic
        // "client information must be saveable for dynamic registration" fallback.
        throw new AuthorizationServerMismatchError(rawClientInfo.issuer, issuer);
    }
    if (clientInformation && clientInformation.issuer === undefined) {
        // SEP-2352 back-stamp: legacy (pre-SEP-2352) storage returned an unstamped value.
        // Bind it to the first AS resolved after upgrade so subsequent calls have a real
        // stamp to compare against — closes the otherwise-permanent unstamped window.
        clientInformation = { ...clientInformation, issuer };
        await provider.saveClientInformation?.(clientInformation, infoCtx);
    }
    if (!clientInformation) {
        if (authorizationCode !== undefined) {
            throw new Error('Existing OAuth client information is required when exchanging an authorization code');
        }

        const supportsUrlBasedClientId = metadata?.client_id_metadata_document_supported === true;
        const clientMetadataUrl = provider.clientMetadataUrl;

        if (clientMetadataUrl && !isHttpsUrl(clientMetadataUrl)) {
            throw new OAuthError(
                OAuthErrorCode.InvalidClientMetadata,
                `clientMetadataUrl must be a valid HTTPS URL with a non-root pathname, got: ${clientMetadataUrl}`
            );
        }

        const shouldUseUrlBasedClientId = supportsUrlBasedClientId && clientMetadataUrl;

        if (shouldUseUrlBasedClientId) {
            // SEP-991: URL-based Client IDs
            clientInformation = { client_id: clientMetadataUrl, issuer };
            await provider.saveClientInformation?.(clientInformation, infoCtx);
        } else {
            // Fallback to dynamic registration
            if (!provider.saveClientInformation) {
                throw new Error('OAuth client information must be saveable for dynamic registration');
            }

            const fullInformation = await registerClientInternal(
                authorizationServerUrl,
                {
                    metadata,
                    clientMetadata,
                    scope: resolvedScope,
                    fetchFn,
                    discoveryPolicy
                },
                trust.validateDiscoveryURL
            );

            clientInformation = { ...fullInformation, issuer };
            await provider.saveClientInformation(clientInformation, infoCtx);
        }
    }

    // Non-interactive flows (e.g., client_credentials, jwt-bearer) don't need a redirect URL
    const nonInteractiveFlow = !provider.redirectUrl;

    // Exchange authorization code for tokens, or fetch tokens directly for non-interactive flows
    if (authorizationCode !== undefined || nonInteractiveFlow) {
        // RFC 9207: validate the callback `iss` against the recorded issuer before the
        // authorization code is sent to any token endpoint. Non-interactive flows have no
        // authorization response, so the gate is keyed on `authorizationCode`.
        if (authorizationCode !== undefined) {
            validateAuthorizationResponseIssuer({
                iss,
                expectedIssuer: metadata?.issuer,
                issParameterSupported: isIssParameterSupported(metadata)
            });
        }

        const tokens = await fetchToken(provider, authorizationServerUrl, {
            metadata,
            resource,
            authorizationCode,
            iss,
            scope: resolvedScope,
            fetchFn,
            discoveryPolicy
        });

        await provider.saveTokens({ ...tokens, issuer }, infoCtx);
        return 'AUTHORIZED';
    }

    // SEP-2352: a refresh_token stamped for a different authorization server reads back
    // as `undefined`, so it is never POSTed to this AS's token endpoint.
    let tokens = discardIfIssuerMismatch(await provider.tokens(infoCtx), issuer);
    if (tokens && tokens.issuer === undefined) {
        // SEP-2352 back-stamp: bind a legacy unstamped token set to the first-resolved AS
        // so the stamp check is effective from the next call onward.
        tokens = { ...tokens, issuer };
        await provider.saveTokens(tokens, infoCtx);
    }

    // Handle token refresh or new authorization. The step-up path sets
    // `forceReauthorization` when the requested scope strictly exceeds the
    // current token's granted scope — refreshing would not widen it (RFC 6749
    // §6), so skip straight to a fresh authorization request.
    if (tokens?.refresh_token && !forceReauthorization) {
        try {
            // Attempt to refresh the token
            const newTokens = await refreshAuthorizationInternal(
                authorizationServerUrl,
                {
                    metadata,
                    clientInformation,
                    refreshToken: tokens.refresh_token,
                    resource,
                    addClientAuthentication: provider.addClientAuthentication,
                    fetchFn,
                    discoveryPolicy
                },
                trust.validateDiscoveryURL
            );

            await provider.saveTokens({ ...newTokens, issuer }, infoCtx);
            return 'AUTHORIZED';
        } catch (error) {
            // A non-TLS, policy-blocked, or redirecting token endpoint is a
            // configuration error — re-authorizing cannot fix it (the exchange
            // POST targets the same endpoint). Surface it so the consumer sees
            // the misconfiguration instead of an unexplained re-auth prompt.
            if (
                error instanceof InsecureTokenEndpointError ||
                error instanceof DiscoveryUrlBlockedError ||
                error instanceof RedirectFilteredResponseError
            ) {
                throw error;
            }
            // If this is a ServerError, or an unknown type, log it out and try to continue. Otherwise, escalate so we can fix things and retry.
            if (!(error instanceof OAuthError) || error.code === OAuthErrorCode.ServerError) {
                // Could not refresh OAuth tokens
            } else {
                // Refresh failed for another reason, re-throw
                throw error;
            }
        }
    }

    const state = provider.state ? await provider.state() : undefined;

    // Start new authorization flow
    const { authorizationUrl, codeVerifier } = await startAuthorizationInternal(
        authorizationServerUrl,
        {
            metadata,
            clientInformation,
            state,
            redirectUrl: provider.redirectUrl,
            scope: resolvedScope,
            resource,
            discoveryPolicy
        },
        trust.validateDiscoveryURL
    );

    await provider.saveCodeVerifier(codeVerifier);
    await provider.redirectToAuthorization(authorizationUrl);
    return 'REDIRECT';
}

/**
 * Validates that the given `clientMetadataUrl` is a valid HTTPS URL with a non-root pathname.
 *
 * No-op when `url` is `undefined` or empty (providers that do not use URL-based client IDs
 * are unaffected). When the value is defined but invalid, throws an {@linkcode OAuthError}
 * with code {@linkcode OAuthErrorCode.InvalidClientMetadata}.
 *
 * {@linkcode OAuthClientProvider} implementations that accept a `clientMetadataUrl` should
 * call this in their constructors for early validation.
 *
 * @param url - The `clientMetadataUrl` value to validate (from `OAuthClientProvider.clientMetadataUrl`)
 * @throws {OAuthError} When `url` is defined but is not a valid HTTPS URL with a non-root pathname
 */
export function validateClientMetadataUrl(url: string | undefined): void {
    if (url && !isHttpsUrl(url)) {
        throw new OAuthError(
            OAuthErrorCode.InvalidClientMetadata,
            `clientMetadataUrl must be a valid HTTPS URL with a non-root pathname, got: ${url}`
        );
    }
}

/**
 * SEP-991: URL-based Client IDs
 * Validate that the `client_id` is a valid URL with `https` scheme
 */
export function isHttpsUrl(value?: string): boolean {
    if (!value) return false;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.pathname !== '/';
    } catch {
        return false;
    }
}

export async function selectResourceURL(
    serverUrl: string | URL,
    provider: OAuthClientProvider,
    resourceMetadata?: OAuthProtectedResourceMetadata
): Promise<URL | undefined> {
    const defaultResource = resourceUrlFromServerUrl(serverUrl);

    // If provider has custom validation, delegate to it
    if (provider.validateResourceURL) {
        return await provider.validateResourceURL(defaultResource, resourceMetadata?.resource);
    }

    // Only include resource parameter when Protected Resource Metadata is present
    if (!resourceMetadata) {
        return undefined;
    }

    // Validate that the metadata's resource is compatible with our request
    if (!checkResourceAllowed({ requestedResource: defaultResource, configuredResource: resourceMetadata.resource })) {
        throw new Error(`Protected resource ${resourceMetadata.resource} does not match expected ${defaultResource} (or origin)`);
    }
    // Prefer the resource from metadata since it's what the server is telling us to request
    return new URL(resourceMetadata.resource);
}

/**
 * Extract `resource_metadata`, `scope`, `error`, and `error_description` from a
 * `WWW-Authenticate` header.
 */
export function extractWWWAuthenticateParams(res: Response): {
    resourceMetadataUrl?: URL;
    scope?: string;
    error?: string;
    errorDescription?: string;
} {
    const authenticateHeader = res.headers.get('WWW-Authenticate');
    if (!authenticateHeader) {
        return {};
    }

    const [type, scheme] = authenticateHeader.split(' ');
    if (type?.toLowerCase() !== 'bearer' || !scheme) {
        return {};
    }

    const resourceMetadataMatch = extractFieldFromWwwAuth(res, 'resource_metadata') || undefined;

    let resourceMetadataUrl: URL | undefined;
    if (resourceMetadataMatch) {
        try {
            resourceMetadataUrl = new URL(resourceMetadataMatch);
        } catch {
            // Ignore invalid URL
        }
    }

    const scope = extractFieldFromWwwAuth(res, 'scope') || undefined;
    const error = extractFieldFromWwwAuth(res, 'error') || undefined;
    const errorDescription = extractFieldFromWwwAuth(res, 'error_description') || undefined;

    return {
        resourceMetadataUrl,
        scope,
        error,
        errorDescription
    };
}

/**
 * Extracts a specific field's value from the `WWW-Authenticate` header string.
 *
 * @param response The HTTP response object containing the headers.
 * @param fieldName The name of the field to extract (e.g., `"realm"`, `"nonce"`).
 * @returns The field value
 */
function extractFieldFromWwwAuth(response: Response, fieldName: string): string | null {
    const wwwAuthHeader = response.headers.get('WWW-Authenticate');
    if (!wwwAuthHeader) {
        return null;
    }

    const pattern = new RegExp(String.raw`${fieldName}=(?:"([^"]+)"|([^\s,]+))`);
    const match = wwwAuthHeader.match(pattern);

    if (match) {
        // Pattern matches: field_name="value" or field_name=value (unquoted)
        const result = match[1] || match[2];
        if (result) {
            return result;
        }
    }

    return null;
}

/**
 * Extract `resource_metadata` from response header.
 * @deprecated Use {@linkcode extractWWWAuthenticateParams} instead.
 */
export function extractResourceMetadataUrl(res: Response): URL | undefined {
    const authenticateHeader = res.headers.get('WWW-Authenticate');
    if (!authenticateHeader) {
        return undefined;
    }

    const [type, scheme] = authenticateHeader.split(' ');
    if (type?.toLowerCase() !== 'bearer' || !scheme) {
        return undefined;
    }
    const regex = /resource_metadata="([^"]*)"/;
    const match = regex.exec(authenticateHeader);

    if (!match || !match[1]) {
        return undefined;
    }

    try {
        return new URL(match[1]);
    } catch {
        return undefined;
    }
}

/**
 * Looks up {@link https://datatracker.ietf.org/doc/html/rfc9728 | RFC 9728}
 * OAuth 2.0 Protected Resource Metadata.
 *
 * If the server returns a 404 for the well-known endpoint, this function will
 * return `undefined`. Any other errors will be thrown as exceptions.
 */
export async function discoverOAuthProtectedResourceMetadata(
    serverUrl: string | URL,
    opts?: {
        protocolVersion?: string;
        resourceMetadataUrl?: string | URL;
        /**
         * Where `resourceMetadataUrl` came from — see
         * {@linkcode ResourceMetadataUrlSource}. Defaults to `'caller'`, which
         * fails closed on a URL-policy rejection; `'www-authenticate'` (a relayed
         * challenge value) warns and falls back to the well-known derivation.
         */
        resourceMetadataUrlSource?: ResourceMetadataUrlSource;
        /**
         * Overrides for the URL policy applied before each discovery request
         * ({@linkcode assertAllowedDiscoveryUrl}). **Policy-weakening**, default off.
         */
        discoveryPolicy?: DiscoveryUrlPolicyOptions;
    },
    fetchFn: FetchLike = fetch
): Promise<OAuthProtectedResourceMetadata> {
    return discoverOAuthProtectedResourceMetadataInternal(serverUrl, opts, fetchFn);
}

/**
 * {@linkcode discoverOAuthProtectedResourceMetadata} with the provider's
 * `validateDiscoveryURL` hook threaded by the calling flow entry
 * ({@linkcode auth} / a transport). Trust flows only from the provider, so the
 * hook rides this internal variant rather than the public signature — direct
 * callers configure it on the provider they hand to those entries.
 */
async function discoverOAuthProtectedResourceMetadataInternal(
    serverUrl: string | URL,
    opts: Parameters<typeof discoverOAuthProtectedResourceMetadata>[1],
    fetchFn: FetchLike = fetch,
    validateDiscoveryURL?: ValidateDiscoveryUrlHook
): Promise<OAuthProtectedResourceMetadata> {
    const response = await discoverMetadataWithFallback(serverUrl, 'oauth-protected-resource', fetchFn, {
        protocolVersion: opts?.protocolVersion,
        metadataUrl: opts?.resourceMetadataUrl,
        metadataUrlSource: opts?.resourceMetadataUrlSource,
        discoveryPolicy: opts?.discoveryPolicy,
        validate: validateDiscoveryURL
    });

    if (!response || response.status === 404) {
        await response?.text?.().catch(() => {});
        throw new Error(`Resource server does not implement OAuth 2.0 Protected Resource Metadata.`);
    }

    if (!response.ok) {
        await response.text?.().catch(() => {});
        throw new Error(`HTTP ${response.status} trying to load well-known OAuth protected resource metadata.`);
    }
    return OAuthProtectedResourceMetadataSchema.parse(await response.json());
}

/**
 * Fetch with a retry heuristic for CORS errors caused by custom headers.
 *
 * In browsers, adding a custom header (e.g. `MCP-Protocol-Version`) triggers a CORS preflight.
 * If the server doesn't allow that header, the browser throws a `TypeError` before any response
 * is received. Retrying without custom headers often succeeds because the request becomes
 * "simple" (no preflight). If the server sends no CORS headers at all, the retry also fails
 * with `TypeError` and we return `undefined` so callers can fall through to an alternate URL.
 *
 * However, `fetch()` also throws `TypeError` for non-CORS failures (DNS resolution, connection
 * refused, invalid URL). Swallowing those and returning `undefined` masks real errors and can
 * cause callers to silently fall through to a different discovery URL. CORS is a browser-only
 * concept, so in non-browser runtimes (Node.js, Workers) a `TypeError` from `fetch` is never a
 * CORS error — there we propagate the error instead of swallowing it.
 *
 * In browsers, we cannot reliably distinguish CORS `TypeError` from network `TypeError` from the
 * error object alone, so the swallow-and-fallthrough heuristic is preserved there.
 */
async function fetchWithCorsRetry(
    url: URL,
    headers: Record<string, string> | undefined,
    fetchFn: FetchLike,
    gate: DiscoveryFetchGate
): Promise<Response | undefined> {
    try {
        return await fetchDiscoveryUrl(url, { headers }, fetchFn, gate);
    } catch (error) {
        if (!(error instanceof TypeError) || !CORS_IS_POSSIBLE) {
            throw error;
        }
        if (headers) {
            // Could be a CORS preflight rejection caused by our custom header. Retry as a simple
            // request: if that succeeds, we've sidestepped the preflight.
            try {
                return await fetchDiscoveryUrl(url, undefined, fetchFn, gate);
            } catch (retryError) {
                if (!(retryError instanceof TypeError)) {
                    throw retryError;
                }
                // Retry also got CORS-blocked (server sends no CORS headers at all).
                // Return undefined so the caller tries the next discovery URL.
                return undefined;
            }
        }
        return undefined;
    }
}

/** Redirect status codes eligible for the bounded manual follow on discovery requests. */
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

/** Maximum number of `Location` hops followed on a discovery request. */
const MAX_DISCOVERY_REDIRECT_HOPS = 3;

/**
 * URL-policy context threaded through the discovery fetch helpers so that the
 * initial URL and every redirect target are validated with the originating
 * purpose on record.
 *
 * @internal Not part of the public barrel; shared with the Cross-App Access
 * helpers so their token requests ride the same validated path.
 */
export interface DiscoveryFetchGate {
    purpose: Exclude<DiscoveryUrlPurpose, 'redirect-hop'>;
    source: DiscoveryUrlSource;
    producer: DiscoveryUrlProducer;
    policy?: DiscoveryUrlPolicyOptions;
    /**
     * The provider's {@linkcode OAuthClientProvider.validateDiscoveryURL} hook,
     * threaded here by the flow entry so the fetch funnel stays provider-agnostic.
     * Runs after the mechanical policy on the initial URL and on every redirect hop.
     */
    validate?: ValidateDiscoveryUrlHook;
}

/**
 * Request shape accepted by {@linkcode fetchDiscoveryUrl}. Defaults to a GET.
 *
 * @internal Not part of the public barrel.
 */
export interface DiscoveryRequestInit {
    method?: 'GET' | 'POST';
    headers?: RequestInit['headers'];
    body?: RequestInit['body'];
}

/**
 * Performs an OAuth-flow request with the URL policy applied before any network
 * I/O: the URL is validated with the gate's purpose
 * ({@linkcode assertAllowedDiscoveryUrl}) before the first request, so every
 * request routed through this helper is gated by construction. All requests are
 * issued with `redirect: 'manual'`.
 *
 * GET requests get a bounded manual follow: each `Location` target is validated
 * with purpose `'redirect-hop'` before it is requested, headers are re-derived
 * per hop and dropped when a hop leaves the current origin (including base
 * headers a `createFetchWithInit` wrapper would otherwise re-apply — see
 * `OMIT_BASE_HEADERS` on the internal barrel), and at most
 * `MAX_DISCOVERY_REDIRECT_HOPS` (3) hops are followed. A redirect that cannot
 * be followed (no `Location` or hop budget exhausted) is returned as-is so the
 * caller's error handling applies — except a runtime-filtered redirect (browser
 * opaque redirect), which fails with `RedirectFilteredResponseError`; see
 * `throwIfRedirectFiltered` below for the mechanism.
 *
 * POST requests (token, registration) are never re-sent to a `Location` target:
 * token responses are terminal (RFC 6749 §5), so a redirect status is returned
 * un-followed and fails the caller's status handling instead.
 *
 * @internal Not part of the public barrel; exported for the Cross-App Access
 * helpers, which issue their token-exchange POSTs through this same path.
 */
export async function fetchDiscoveryUrl(
    url: URL,
    init: DiscoveryRequestInit | undefined,
    fetchFn: FetchLike,
    gate: DiscoveryFetchGate
): Promise<Response> {
    const initialContext: DiscoveryUrlContext = { purpose: gate.purpose, url, producer: gate.producer, source: gate.source };
    assertAllowedDiscoveryUrl(initialContext, gate.policy);
    await invokeValidateDiscoveryUrlHook(initialContext, gate.validate);
    const method = init?.method ?? 'GET';
    let currentUrl = url;
    let currentHeaders = init?.headers;
    let response = await fetchFn(currentUrl, { method, headers: currentHeaders, body: init?.body, redirect: 'manual' });
    throwIfRedirectFiltered(response, currentUrl, gate, method);
    if (method !== 'GET') {
        return response;
    }
    for (let hop = 0; REDIRECT_STATUS_CODES.has(response.status); hop++) {
        const location = response.headers.get('location');
        if (location === null || hop >= MAX_DISCOVERY_REDIRECT_HOPS) {
            return response;
        }
        let nextUrl: URL;
        try {
            nextUrl = new URL(location, currentUrl);
        } catch {
            // An unparsable Location cannot be followed; surface the redirect response
            // itself so the caller's HTTP error handling reports it (a URL-parse
            // TypeError would be misread as a cross-origin fetch rejection by the
            // retry heuristic in fetchWithCorsRetry).
            return response;
        }
        const hopContext: DiscoveryUrlContext = {
            purpose: 'redirect-hop',
            url: nextUrl,
            // A hop is judged against the producer of the request being followed.
            producer: gate.producer,
            source: gate.source,
            redirectHop: { from: currentUrl, status: response.status, originalPurpose: gate.purpose }
        };
        assertAllowedDiscoveryUrl(hopContext, gate.policy);
        await invokeValidateDiscoveryUrlHook(hopContext, gate.validate);
        // Release the intermediate response before following the hop.
        await response.text?.().catch(() => {});
        if (nextUrl.origin !== currentUrl.origin) {
            // Headers never travel across origins on a redirect. The sentinel (rather
            // than plain `undefined`) also keeps a createFetchWithInit wrapper — the
            // transports' `oauthRequestInit` fetch — from falling back to its base
            // headers on the cross-origin request.
            currentHeaders = OMIT_BASE_HEADERS;
        }
        currentUrl = nextUrl;
        response = await fetchFn(currentUrl, { method, headers: currentHeaders, redirect: 'manual' });
        throwIfRedirectFiltered(response, currentUrl, gate, method, true);
    }
    return response;
}

/**
 * Fails a request whose response is a redirect the runtime filtered. Browser
 * runtimes resolve a `redirect: 'manual'` fetch whose response status is a
 * redirect with an opaque redirect (Fetch `Response.type === 'opaqueredirect'`:
 * status 0, no readable `Location` header), so the redirect target cannot be
 * observed. {@linkcode fetchDiscoveryUrl} checks every redirect target before
 * following it; a target that cannot be observed cannot be checked, so a
 * filtered redirect fails with `RedirectFilteredResponseError` instead of
 * surfacing as an unexplained `HTTP 0` status. When the filtered response
 * answers a followed hop, the error reports purpose `'redirect-hop'` and
 * carries `redirectHop` (`from` is the URL that answered with the filtered
 * redirect, `status` is the filtered response's literal `0`), matching the
 * context shape of other hop-stage rejections.
 *
 * How callers handle the failure depends on what the request was for: the
 * SDK-derived well-known probes treat it as "not retrievably served" and
 * degrade exactly like a 404 (see {@linkcode discoverOAuthServerInfo}'s legacy
 * fallback and the {@linkcode discoverAuthorizationServerMetadata} candidate
 * loop), a challenge-relayed metadata URL falls back to the well-known
 * derivation with a warning (see `discoverMetadataWithFallback`), and a
 * caller-configured metadata URL or a token/registration POST fails. Redirected
 * POST responses are never followed in any runtime — token responses are
 * terminal (RFC 6749 §5) — so for POSTs the message points at the endpoint
 * configuration rather than the runtime.
 */
function throwIfRedirectFiltered(
    response: Response,
    url: URL,
    gate: DiscoveryFetchGate,
    method: 'GET' | 'POST',
    followedHop = false
): void {
    if (response.type !== 'opaqueredirect') {
        return;
    }
    const detail =
        method === 'POST'
            ? 'redirected responses to this request are never followed, in any runtime (token responses are terminal, RFC 6749 §5); serve this endpoint without a redirect'
            : 'serve the document at this URL without a redirect, or run the flow in a runtime that exposes redirect responses (a redirect target that passes validation is then followed)';
    throw new RedirectFilteredResponseError(
        url,
        followedHop ? 'redirect-hop' : gate.purpose,
        detail,
        followedHop ? { from: url, status: 0, originalPurpose: gate.purpose } : undefined
    );
}

/**
 * Constructs the well-known path for auth-related metadata discovery
 */
function buildWellKnownPath(
    wellKnownPrefix: 'oauth-authorization-server' | 'oauth-protected-resource' | 'openid-configuration',
    pathname: string = '',
    options: { prependPathname?: boolean } = {}
): string {
    // Strip trailing slash from pathname to avoid double slashes
    if (pathname.endsWith('/')) {
        pathname = pathname.slice(0, -1);
    }

    return options.prependPathname ? `${pathname}/.well-known/${wellKnownPrefix}` : `/.well-known/${wellKnownPrefix}${pathname}`;
}

/**
 * Tries to discover OAuth metadata at a specific URL
 */
async function tryMetadataDiscovery(
    url: URL,
    protocolVersion: string,
    fetchFn: FetchLike = fetch,
    gate: DiscoveryFetchGate
): Promise<Response | undefined> {
    const headers = {
        'MCP-Protocol-Version': protocolVersion
    };
    return await fetchWithCorsRetry(url, headers, fetchFn, gate);
}

/**
 * Determines if fallback to root discovery should be attempted
 */
function shouldAttemptFallback(response: Response | undefined, pathname: string): boolean {
    if (!response) return true; // CORS error — always try fallback
    if (pathname === '/') return false; // Already at root
    return (response.status >= 400 && response.status < 500) || response.status === 502;
}

/**
 * Generic function for discovering OAuth metadata with fallback support
 */
async function discoverMetadataWithFallback(
    serverUrl: string | URL,
    wellKnownType: 'oauth-authorization-server' | 'oauth-protected-resource',
    fetchFn: FetchLike,
    opts?: {
        protocolVersion?: string;
        metadataUrl?: string | URL;
        /** Provenance of `metadataUrl`; picks the rejection handling below. */
        metadataUrlSource?: ResourceMetadataUrlSource;
        metadataServerUrl?: string | URL;
        discoveryPolicy?: DiscoveryUrlPolicyOptions;
        /** The provider's hook, run at each fetch checkpoint (see {@linkcode DiscoveryFetchGate.validate}). */
        validate?: ValidateDiscoveryUrlHook;
    }
): Promise<Response | undefined> {
    const protocolVersion = opts?.protocolVersion ?? LATEST_PROTOCOL_VERSION;
    const purpose: DiscoveryFetchGate['purpose'] = wellKnownType === 'oauth-protected-resource' ? 'resource-metadata' : 'as-metadata';
    // Protected-resource metadata is produced by the MCP server itself; the
    // authorization-server well-known lookup (the deprecated direct path) is
    // anchored on the authorization server whose metadata is being fetched.
    const producer: DiscoveryUrlProducer = {
        url: new URL(serverUrl),
        kind: wellKnownType === 'oauth-protected-resource' ? 'mcp-server' : 'authorization-server'
    };

    if (opts?.metadataUrl) {
        // An explicit metadata URL is validated before it is requested, and its
        // provenance picks the handling of a non-usable value. A URL relayed
        // from a WWW-Authenticate challenge is network-derived input: when it is
        // non-conformant — most commonly not same-origin with the server
        // (RFC 9728 §3) — or when its response is a redirect the runtime
        // filters, the URL is ignored with a warning and discovery falls back to
        // the SDK's own well-known derivation below, identical to the path taken
        // when no metadata URL is supplied at all. (A rejection from the
        // provider's validateDiscoveryURL hook is not covered — it propagates.)
        // A caller-configured URL ('caller', the default) is a configuration
        // statement: rejecting it fails closed rather than silently discovering
        // at a different location.
        const explicitSource = opts.metadataUrlSource ?? 'caller';
        const explicitUrl = new URL(opts.metadataUrl);
        let explicitUrlUsable = true;
        try {
            assertAllowedDiscoveryUrl({ purpose, url: explicitUrl, producer, source: explicitSource }, opts?.discoveryPolicy);
        } catch (error) {
            if (!(error instanceof DiscoveryUrlBlockedError) || explicitSource !== 'www-authenticate') {
                throw error;
            }
            explicitUrlUsable = false;
            console.warn(`[mcp-sdk] Ignoring the provided metadata URL and using well-known discovery instead: ${error.message}`);
        }
        if (explicitUrlUsable) {
            const gate: DiscoveryFetchGate = {
                purpose,
                source: explicitSource,
                producer,
                policy: opts?.discoveryPolicy,
                validate: opts?.validate
            };
            try {
                return await tryMetadataDiscovery(explicitUrl, protocolVersion, fetchFn, gate);
            } catch (error) {
                if (!(error instanceof RedirectFilteredResponseError) || explicitSource !== 'www-authenticate') {
                    throw error;
                }
                console.warn(`[mcp-sdk] Ignoring the provided metadata URL and using well-known discovery instead: ${error.message}`);
            }
        }
    }

    // Try path-aware discovery first
    const wellKnownPath = buildWellKnownPath(wellKnownType, producer.url.pathname);
    const url = new URL(wellKnownPath, opts?.metadataServerUrl ?? producer.url);
    url.search = producer.url.search;

    const gate: DiscoveryFetchGate = { purpose, source: 'sdk-derived', producer, policy: opts?.discoveryPolicy, validate: opts?.validate };

    // On the SDK-derived probes, a runtime-filtered redirect means the document
    // is not retrievably served at that URL — the same situation as a 404, so it
    // is fallback-eligible the same way. It is recorded rather than returned
    // (there is no response to return) and surfaces only when no probe answers.
    let filtered: RedirectFilteredResponseError | undefined;
    const probe = async (probeUrl: URL): Promise<Response | undefined> => {
        filtered = undefined;
        try {
            return await tryMetadataDiscovery(probeUrl, protocolVersion, fetchFn, gate);
        } catch (error) {
            if (!(error instanceof RedirectFilteredResponseError)) {
                throw error;
            }
            filtered = error;
            return undefined;
        }
    };

    let response = await probe(url);

    // If path-aware discovery fails (4xx or 502 Bad Gateway) and we're not already at root, try fallback to root discovery
    if (producer.url.pathname !== '/' && (filtered !== undefined || shouldAttemptFallback(response, producer.url.pathname))) {
        const rootUrl = new URL(`/.well-known/${wellKnownType}`, producer.url);
        response = await probe(rootUrl);
    }

    if (filtered !== undefined) {
        throw filtered;
    }
    return response;
}

/**
 * Looks up RFC 8414 OAuth 2.0 Authorization Server Metadata.
 *
 * If the server returns a 404 for the well-known endpoint, this function will
 * return `undefined`. Any other errors will be thrown as exceptions.
 *
 * Each candidate URL is checked against the discovery URL policy
 * ({@linkcode assertAllowedDiscoveryUrl}) before it is requested; a rejected
 * URL fails the lookup with {@linkcode DiscoveryUrlBlockedError}. Use
 * `discoveryPolicy` to override individual rules, as with
 * {@linkcode discoverAuthorizationServerMetadata}.
 *
 * @deprecated This function is deprecated in favor of {@linkcode discoverAuthorizationServerMetadata}.
 */
export async function discoverOAuthMetadata(
    issuer: string | URL,
    {
        authorizationServerUrl,
        protocolVersion,
        discoveryPolicy
    }: {
        authorizationServerUrl?: string | URL;
        protocolVersion?: string;
        /**
         * Overrides for the URL policy applied before each discovery request
         * ({@linkcode assertAllowedDiscoveryUrl}). **Policy-weakening**, default off.
         */
        discoveryPolicy?: DiscoveryUrlPolicyOptions;
    } = {},
    fetchFn: FetchLike = fetch
): Promise<OAuthMetadata | undefined> {
    if (typeof issuer === 'string') {
        issuer = new URL(issuer);
    }
    if (!authorizationServerUrl) {
        authorizationServerUrl = issuer;
    }
    if (typeof authorizationServerUrl === 'string') {
        authorizationServerUrl = new URL(authorizationServerUrl);
    }
    protocolVersion ??= LATEST_PROTOCOL_VERSION;

    const response = await discoverMetadataWithFallback(authorizationServerUrl, 'oauth-authorization-server', fetchFn, {
        protocolVersion,
        metadataServerUrl: authorizationServerUrl,
        discoveryPolicy
    });

    if (!response || response.status === 404) {
        await response?.text?.().catch(() => {});
        return undefined;
    }

    if (!response.ok) {
        await response.text?.().catch(() => {});
        throw new Error(`HTTP ${response.status} trying to load well-known OAuth metadata`);
    }

    return OAuthMetadataSchema.parse(await response.json());
}

/**
 * Builds a list of discovery URLs to try for authorization server metadata.
 * URLs are returned in priority order:
 * 1. OAuth metadata at the given URL
 * 2. OIDC metadata endpoints at the given URL
 */
export function buildDiscoveryUrls(authorizationServerUrl: string | URL): { url: URL; type: 'oauth' | 'oidc' }[] {
    const url = typeof authorizationServerUrl === 'string' ? new URL(authorizationServerUrl) : authorizationServerUrl;
    const hasPath = url.pathname !== '/';
    const urlsToTry: { url: URL; type: 'oauth' | 'oidc' }[] = [];

    if (!hasPath) {
        urlsToTry.push(
            // Root path: https://example.com/.well-known/oauth-authorization-server

            {
                url: new URL('/.well-known/oauth-authorization-server', url.origin),
                type: 'oauth'
            },
            // OIDC: https://example.com/.well-known/openid-configuration

            {
                url: new URL(`/.well-known/openid-configuration`, url.origin),
                type: 'oidc'
            }
        );

        return urlsToTry;
    }

    // Strip trailing slash from pathname to avoid double slashes
    let pathname = url.pathname;
    if (pathname.endsWith('/')) {
        pathname = pathname.slice(0, -1);
    }

    urlsToTry.push(
        // 1. OAuth metadata at the given URL
        // Insert well-known before the path: https://example.com/.well-known/oauth-authorization-server/tenant1
        {
            url: new URL(`/.well-known/oauth-authorization-server${pathname}`, url.origin),
            type: 'oauth'
        },
        // 2. OIDC metadata endpoints
        // RFC 8414 style: Insert /.well-known/openid-configuration before the path
        {
            url: new URL(`/.well-known/openid-configuration${pathname}`, url.origin),
            type: 'oidc'
        },
        // OIDC Discovery 1.0 style: Append /.well-known/openid-configuration after the path

        {
            url: new URL(`${pathname}/.well-known/openid-configuration`, url.origin),
            type: 'oidc'
        }
    );

    return urlsToTry;
}

/**
 * Discovers authorization server metadata with support for
 * {@link https://datatracker.ietf.org/doc/html/rfc8414 | RFC 8414} OAuth 2.0
 * Authorization Server Metadata and
 * {@link https://openid.net/specs/openid-connect-discovery-1_0.html | OpenID Connect Discovery 1.0}
 * specifications.
 *
 * This function implements a fallback strategy for authorization server discovery:
 * 1. Attempts RFC 8414 OAuth metadata discovery first
 * 2. If OAuth discovery fails, falls back to OpenID Connect Discovery
 *
 * @param authorizationServerUrl - The authorization server URL obtained from the MCP Server's
 *                                 protected resource metadata, or the MCP server's URL if the
 *                                 metadata was not found.
 * The returned metadata's `issuer` is validated against `authorizationServerUrl`
 * per RFC 8414 §3.3 (and OIDC Discovery §4.3): if they differ the metadata is
 * **rejected** with {@linkcode IssuerMismatchError} and not returned. Set
 * `skipIssuerValidation: true` to suppress this check — **security-weakening**,
 * intended only for known-misconfigured authorization servers.
 *
 * @param options - Configuration options
 * @param options.fetchFn - Optional fetch function for making HTTP requests, defaults to global fetch
 * @param options.protocolVersion - MCP protocol version to use, defaults to {@linkcode LATEST_PROTOCOL_VERSION}
 * @param options.skipIssuerValidation - Skip the RFC 8414 §3.3 `issuer` echo check. **Security-weakening.**
 * @returns Promise resolving to authorization server metadata, or undefined if discovery fails
 * @throws {IssuerMismatchError} when the metadata's `issuer` does not match `authorizationServerUrl`
 */
export async function discoverAuthorizationServerMetadata(
    authorizationServerUrl: string | URL,
    options: {
        fetchFn?: FetchLike;
        protocolVersion?: string;
        skipIssuerValidation?: boolean;
        /**
         * Overrides for the URL policy applied before each discovery request
         * ({@linkcode assertAllowedDiscoveryUrl}). **Policy-weakening**, default off.
         */
        discoveryPolicy?: DiscoveryUrlPolicyOptions;
    } = {}
): Promise<AuthorizationServerMetadata | undefined> {
    return discoverAuthorizationServerMetadataInternal(authorizationServerUrl, options);
}

/**
 * {@linkcode discoverAuthorizationServerMetadata} with the provider's
 * `validateDiscoveryURL` hook threaded by the calling flow entry
 * ({@linkcode auth} / a transport). Trust flows only from the provider, so the
 * hook rides this internal variant rather than the public signature — direct
 * callers configure it on the provider they hand to those entries.
 */
async function discoverAuthorizationServerMetadataInternal(
    authorizationServerUrl: string | URL,
    {
        fetchFn = fetch,
        protocolVersion = LATEST_PROTOCOL_VERSION,
        skipIssuerValidation = false,
        discoveryPolicy
    }: NonNullable<Parameters<typeof discoverAuthorizationServerMetadata>[1]> = {},
    validateDiscoveryURL?: ValidateDiscoveryUrlHook
): Promise<AuthorizationServerMetadata | undefined> {
    const headers = {
        'MCP-Protocol-Version': protocolVersion,
        Accept: 'application/json'
    };

    // Get the list of URLs to try
    const urlsToTry = buildDiscoveryUrls(authorizationServerUrl);

    // URL-policy producer for the discovery requests below. The derived URLs share the
    // authorization server's origin, so this primarily enforces the structural rules
    // (https-or-loopback, no userinfo) for direct callers of this function; within
    // auth() the authorization server URL has already passed the adoption checks.
    const gate: DiscoveryFetchGate = {
        purpose: 'as-metadata',
        source: 'sdk-derived',
        producer: { url: new URL(authorizationServerUrl), kind: 'authorization-server' },
        policy: discoveryPolicy,
        validate: validateDiscoveryURL
    };

    // Try each URL in order. Each candidate is validated inside the fetch path
    // before any request leaves the client; a rejected URL fails the whole
    // discovery rather than falling through to the next candidate.
    for (const { url: endpointUrl, type } of urlsToTry) {
        let response: Response | undefined;
        try {
            response = await fetchWithCorsRetry(endpointUrl, headers, fetchFn, gate);
        } catch (error) {
            if (!(error instanceof RedirectFilteredResponseError)) {
                throw error;
            }
            // A runtime-filtered redirect means the metadata document is not
            // retrievably served at this candidate — the same degradation as a
            // 404: try the next one.
            continue;
        }

        if (!response) {
            /**
             * CORS error occurred - don't throw as the endpoint may not allow CORS,
             * continue trying other possible endpoints
             */
            continue;
        }

        if (!response.ok) {
            await response.text?.().catch(() => {});
            if ((response.status >= 400 && response.status < 500) || response.status === 502) {
                continue; // Try next URL for 4xx or 502 (Bad Gateway)
            }
            throw new Error(
                `HTTP ${response.status} trying to load ${type === 'oauth' ? 'OAuth' : 'OpenID provider'} metadata from ${endpointUrl}`
            );
        }

        // Parse and validate based on type
        const parsed =
            type === 'oauth'
                ? OAuthMetadataSchema.parse(await response.json())
                : OpenIdProviderDiscoveryMetadataSchema.parse(await response.json());

        if (!skipIssuerValidation) {
            // RFC 8414 §3.3 / OIDC Discovery §4.3: the `issuer` value in the document MUST be
            // identical to the issuer identifier used to construct the well-known URL. Compare
            // against the raw input string — callers pass the exact issuer string the AS published.
            const expectedIssuer = typeof authorizationServerUrl === 'string' ? authorizationServerUrl : authorizationServerUrl.href;
            // One narrow tolerance: the SDK's own legacy-fallback path synthesizes the AS URL via
            // `String(new URL('/', serverUrl))`, which always carries a trailing `/`. That value is
            // SDK-generated (not attacker-controlled), so accept the slash-only difference here.
            // The tolerance is one-directional and end-anchored — a different host or path is still
            // a mismatch.
            const matches =
                parsed.issuer === expectedIssuer || (expectedIssuer.endsWith('/') && parsed.issuer === expectedIssuer.slice(0, -1));
            if (!matches) {
                throw new IssuerMismatchError('metadata', expectedIssuer, parsed.issuer);
            }
        }

        return parsed;
    }

    return undefined;
}

/**
 * Signature of {@linkcode OAuthClientProvider.validateDiscoveryURL}, as threaded
 * from a flow entry to the URL checkpoints (already bound to the provider).
 *
 * @internal Not part of the public barrel.
 */
export type ValidateDiscoveryUrlHook = (ctx: DiscoveryUrlContext) => void | Promise<void>;

/**
 * Runs a provider's `validateDiscoveryURL` hook against a context that has already
 * passed the mechanical URL policy. A rejection always surfaces as
 * {@linkcode DiscoveryUrlBlockedError}: a hook throw of any other type is wrapped
 * (with the original throw as `cause`), so callers observe one failure type for
 * every URL-policy or trust rejection.
 */
async function invokeValidateDiscoveryUrlHook(ctx: DiscoveryUrlContext, validate: ValidateDiscoveryUrlHook | undefined): Promise<void> {
    if (!validate) {
        return;
    }
    try {
        await validate(ctx);
    } catch (error) {
        if (error instanceof DiscoveryUrlBlockedError) {
            throw error;
        }
        const blocked = new DiscoveryUrlBlockedError(
            ctx,
            `rejected by the provider's validateDiscoveryURL hook: ${error instanceof Error ? error.message : String(error)}`
        );
        blocked.cause = error;
        throw blocked;
    }
}

/**
 * The RFC 9728 §7.6 trust members of an {@linkcode OAuthClientProvider}
 * ({@linkcode OAuthClientProvider.trustedAuthorizationServers | trustedAuthorizationServers}
 * and {@linkcode OAuthClientProvider.validateDiscoveryURL | validateDiscoveryURL}),
 * resolved once at flow entry and threaded to the URL checkpoints. Trust flows only
 * from the provider: standalone callers configure it by implementing these members on
 * the provider they hand to {@linkcode auth} (or a transport), not through loose
 * per-call options.
 *
 * @internal Not part of the public barrel.
 */
export interface AuthorizationServerTrust {
    /** See {@linkcode OAuthClientProvider.trustedAuthorizationServers}. */
    trustedAuthorizationServers?: (string | URL)[];
    /** See {@linkcode OAuthClientProvider.validateDiscoveryURL}. */
    validateDiscoveryURL?(ctx: DiscoveryUrlContext): void | Promise<void>;
}

/**
 * RFC 9728 §7.6 trust verification applied when an authorization server URL is
 * adopted (fresh discovery or cached-state restore), after the mechanical URL policy
 * ({@linkcode assertAllowedDiscoveryUrl}): the exhaustive
 * `trustedAuthorizationServers` match when configured — full issuer identifiers,
 * tolerating only a trailing-slash difference — then the `validateDiscoveryURL`
 * hook when implemented.
 */
async function verifyAuthorizationServerTrust(ctx: DiscoveryUrlContext, trust: AuthorizationServerTrust): Promise<void> {
    // Both trust inputs are optional and default to undefined — when neither is
    // configured no trust verification runs.
    const trustedServers = trust.trustedAuthorizationServers;
    if (trustedServers !== undefined) {
        const trustedIssuers = trustedServers.map(entry => {
            try {
                return new URL(String(entry)).href;
            } catch {
                throw new Error(`Invalid trustedAuthorizationServers entry (must be an absolute URL): ${String(entry)}`);
            }
        });
        if (!trustedIssuers.some(entry => issuersMatch(entry, ctx.url.href))) {
            throw new DiscoveryUrlBlockedError(
                ctx,
                'the authorization server issuer does not match any trustedAuthorizationServers entry (RFC 9728 §7.6)'
            );
        }
    }
    await invokeValidateDiscoveryUrlHook(ctx, trust.validateDiscoveryURL);
}

/**
 * Result of {@linkcode discoverOAuthServerInfo}.
 */
export interface OAuthServerInfo {
    /**
     * The authorization server URL, either discovered via RFC 9728
     * or derived from the MCP server URL as a fallback.
     */
    authorizationServerUrl: string;

    /**
     * The authorization server metadata (endpoints, capabilities),
     * or `undefined` if metadata discovery failed.
     */
    authorizationServerMetadata?: AuthorizationServerMetadata;

    /**
     * The OAuth 2.0 Protected Resource Metadata from RFC 9728,
     * or `undefined` if the server does not support it.
     */
    resourceMetadata?: OAuthProtectedResourceMetadata;
}

/**
 * Discovers the authorization server for an MCP server following
 * {@link https://datatracker.ietf.org/doc/html/rfc9728 | RFC 9728} (OAuth 2.0 Protected
 * Resource Metadata), with fallback to treating the server URL as the
 * authorization server.
 *
 * This function combines two discovery steps into one call:
 * 1. Probes `/.well-known/oauth-protected-resource` on the MCP server to find the
 *    authorization server URL (RFC 9728).
 * 2. Fetches authorization server metadata from that URL (RFC 8414 / OpenID Connect Discovery).
 *
 * Use this when you need the authorization server metadata for operations outside the
 * {@linkcode auth} orchestrator, such as token refresh or token revocation.
 *
 * RFC 9728 §7.6 trust verification of the adopted authorization server is configured
 * on the {@linkcode OAuthClientProvider} (`trustedAuthorizationServers` /
 * `validateDiscoveryURL`) and applies when this discovery runs inside a
 * provider-driven flow ({@linkcode auth} or a transport); there is no per-call
 * trust override.
 *
 * @param serverUrl - The MCP resource server URL
 * @param opts - Optional configuration
 * @param opts.resourceMetadataUrl - Override URL for the protected resource metadata endpoint
 * @param opts.fetchFn - Custom fetch function for HTTP requests
 * @returns Authorization server URL, metadata, and resource metadata (if available)
 */
export async function discoverOAuthServerInfo(
    serverUrl: string | URL,
    opts?: {
        resourceMetadataUrl?: URL;
        /**
         * Where `resourceMetadataUrl` came from — see
         * {@linkcode ResourceMetadataUrlSource}. Defaults to `'caller'`, which
         * fails closed on a URL-policy rejection.
         */
        resourceMetadataUrlSource?: ResourceMetadataUrlSource;
        fetchFn?: FetchLike;
        /**
         * Forwarded to {@linkcode discoverAuthorizationServerMetadata} as
         * `skipIssuerValidation`. **Security-weakening** — see {@linkcode AuthOptions.skipIssuerMetadataValidation}.
         */
        skipIssuerMetadataValidation?: boolean;
        /**
         * Overrides for the URL policy applied before each discovery request or
         * adoption ({@linkcode assertAllowedDiscoveryUrl}). **Policy-weakening**, default off.
         */
        discoveryPolicy?: DiscoveryUrlPolicyOptions;
    }
): Promise<OAuthServerInfo> {
    return discoverOAuthServerInfoInternal(serverUrl, opts);
}

/**
 * Whether a protected-resource-metadata discovery failure is a runtime-filtered
 * redirect ({@linkcode RedirectFilteredResponseError}) on a caller-configured
 * metadata URL. A caller-configured URL is a configuration statement, so its
 * failure propagates out of the flow; the same failure on an SDK-derived
 * well-known probe means the metadata is not retrievably served there and
 * degrades exactly like a 404. (A challenge-relayed URL never reaches these
 * catch sites with this error — its filtered redirect falls back to the
 * well-known derivation inside `discoverMetadataWithFallback`.)
 */
function isFilteredCallerMetadataUrl(
    error: unknown,
    explicitUrl: string | URL | undefined,
    source: ResourceMetadataUrlSource | undefined
): boolean {
    return error instanceof RedirectFilteredResponseError && explicitUrl !== undefined && (source ?? 'caller') === 'caller';
}

/**
 * {@linkcode discoverOAuthServerInfo} with the provider's RFC 9728 §7.6 trust
 * members ({@linkcode AuthorizationServerTrust}) threaded by the calling flow
 * entry ({@linkcode auth} / a transport). Trust flows only from the provider,
 * so it rides this internal variant rather than the public signature — direct
 * callers configure it on the provider they hand to those entries.
 *
 * @internal Not part of the public barrel; exported for the policy wiring
 * tests, which drive the trust seam directly.
 */
export async function discoverOAuthServerInfoInternal(
    serverUrl: string | URL,
    opts: Parameters<typeof discoverOAuthServerInfo>[1],
    trust?: AuthorizationServerTrust
): Promise<OAuthServerInfo> {
    const serverUrlObject = new URL(serverUrl);
    let resourceMetadata: OAuthProtectedResourceMetadata | undefined;
    let authorizationServerUrl: string | undefined;

    try {
        resourceMetadata = await discoverOAuthProtectedResourceMetadataInternal(
            serverUrl,
            {
                resourceMetadataUrl: opts?.resourceMetadataUrl,
                resourceMetadataUrlSource: opts?.resourceMetadataUrlSource,
                discoveryPolicy: opts?.discoveryPolicy
            },
            opts?.fetchFn,
            trust?.validateDiscoveryURL
        );
    } catch (error) {
        // Network failures (DNS, connection refused) surface as TypeError from fetch. Those are
        // transient reachability problems, not "server doesn't support PRM" — propagate so the
        // caller sees the real error instead of silently falling back to a different auth server.
        // A URL-policy rejection (e.g. a redirect hop into blocked address space) likewise fails
        // closed rather than silently switching to the legacy authorization server, as does a
        // runtime-filtered redirect on a caller-configured metadata URL (an SDK-derived probe's
        // filtered redirect instead degrades to the fallback below, exactly like a 404).
        if (
            error instanceof TypeError ||
            error instanceof DiscoveryUrlBlockedError ||
            isFilteredCallerMetadataUrl(error, opts?.resourceMetadataUrl, opts?.resourceMetadataUrlSource)
        ) {
            throw error;
        }
        // RFC 9728 not supported -- fall back to treating the server URL as the authorization server
    }

    if (resourceMetadata?.authorization_servers && resourceMetadata.authorization_servers.length > 0) {
        // RFC 9728 §7.6: the authorization server named by the protected-resource
        // metadata must pass the URL policy — and the caller's trust verification,
        // when configured — before it is adopted. Fail closed: a rejected entry
        // neither falls back to the legacy serverUrl-derived authorization server
        // (that would silently change the authorization server identity) nor falls
        // through to another `authorization_servers` entry.
        const candidate = resourceMetadata.authorization_servers[0]!;
        const adoptionContext: DiscoveryUrlContext = {
            purpose: 'authorization-server',
            url: new URL(candidate),
            producer: { url: serverUrlObject, kind: 'mcp-server' },
            source: 'protected-resource-metadata'
        };
        assertAllowedDiscoveryUrl(adoptionContext, opts?.discoveryPolicy);
        await verifyAuthorizationServerTrust(adoptionContext, trust ?? {});
        authorizationServerUrl = candidate;
    }

    // If we don't get a valid authorization server from protected resource metadata,
    // fall back to the legacy MCP spec behavior: MCP server base URL acts as the authorization server
    if (!authorizationServerUrl) {
        authorizationServerUrl = String(new URL('/', serverUrl));
        // The legacy fallback is an adoption like any other: the mechanical policy
        // and the caller's RFC 9728 §7.6 trust verification both apply, so whether
        // the server serves protected-resource metadata cannot change which
        // authorization servers the caller has agreed to. A configured trust list
        // must name the server's base URL for the fallback to be taken; hooks can
        // tell this path apart by `source: 'sdk-derived'`.
        const fallbackContext: DiscoveryUrlContext = {
            purpose: 'authorization-server',
            url: new URL(authorizationServerUrl),
            producer: { url: serverUrlObject, kind: 'mcp-server' },
            source: 'sdk-derived'
        };
        assertAllowedDiscoveryUrl(fallbackContext, opts?.discoveryPolicy);
        await verifyAuthorizationServerTrust(fallbackContext, trust ?? {});
    }

    const authorizationServerMetadata = await discoverAuthorizationServerMetadataInternal(
        authorizationServerUrl,
        {
            fetchFn: opts?.fetchFn,
            skipIssuerValidation: opts?.skipIssuerMetadataValidation,
            discoveryPolicy: opts?.discoveryPolicy
        },
        trust?.validateDiscoveryURL
    );

    return {
        authorizationServerUrl,
        authorizationServerMetadata,
        resourceMetadata
    };
}

/**
 * Begins the authorization flow with the given server, by generating a PKCE challenge and constructing the authorization URL.
 */
export async function startAuthorization(
    authorizationServerUrl: string | URL,
    options: {
        metadata?: AuthorizationServerMetadata;
        clientInformation: OAuthClientInformationMixed;
        redirectUrl: string | URL;
        scope?: string;
        state?: string;
        resource?: URL;
        /**
         * Overrides for the URL policy applied to the authorization endpoint
         * ({@linkcode assertAllowedDiscoveryUrl}). **Policy-weakening**, default off.
         */
        discoveryPolicy?: DiscoveryUrlPolicyOptions;
    }
): Promise<{ authorizationUrl: URL; codeVerifier: string }> {
    return startAuthorizationInternal(authorizationServerUrl, options);
}

/**
 * {@linkcode startAuthorization} with the provider's `validateDiscoveryURL`
 * hook threaded by the calling flow entry ({@linkcode auth} / a transport).
 * Trust flows only from the provider, so the hook rides this internal variant
 * rather than the public signature — direct callers configure it on the
 * provider they hand to those entries.
 */
async function startAuthorizationInternal(
    authorizationServerUrl: string | URL,
    { metadata, clientInformation, redirectUrl, scope, state, resource, discoveryPolicy }: Parameters<typeof startAuthorization>[1],
    validateDiscoveryURL?: ValidateDiscoveryUrlHook
): Promise<{ authorizationUrl: URL; codeVerifier: string }> {
    let authorizationUrl: URL;
    if (metadata) {
        authorizationUrl = new URL(metadata.authorization_endpoint);

        if (!metadata.response_types_supported.includes(AUTHORIZATION_CODE_RESPONSE_TYPE)) {
            throw new Error(`Incompatible auth server: does not support response type ${AUTHORIZATION_CODE_RESPONSE_TYPE}`);
        }

        if (
            metadata.code_challenge_methods_supported &&
            !metadata.code_challenge_methods_supported.includes(AUTHORIZATION_CODE_CHALLENGE_METHOD)
        ) {
            throw new Error(`Incompatible auth server: does not support code challenge method ${AUTHORIZATION_CODE_CHALLENGE_METHOD}`);
        }
    } else {
        authorizationUrl = new URL('/authorize', authorizationServerUrl);
    }

    // The user agent is redirected here carrying the authorization request, so the
    // endpoint gets the same https-or-loopback and locality rules as every fetched
    // endpoint, keyed on the authorization server that published it. Asserted only —
    // this URL is never requested by the SDK.
    const authorizationEndpointContext: DiscoveryUrlContext = {
        purpose: 'authorization-endpoint',
        url: authorizationUrl,
        producer: { url: new URL(authorizationServerUrl), kind: 'authorization-server' },
        source: metadata ? 'authorization-server-metadata' : 'sdk-derived'
    };
    assertAllowedDiscoveryUrl(authorizationEndpointContext, discoveryPolicy);
    await invokeValidateDiscoveryUrlHook(authorizationEndpointContext, validateDiscoveryURL);

    // Generate PKCE challenge
    const challenge = await pkceChallenge();
    const codeVerifier = challenge.code_verifier;
    const codeChallenge = challenge.code_challenge;

    authorizationUrl.searchParams.set('response_type', AUTHORIZATION_CODE_RESPONSE_TYPE);
    authorizationUrl.searchParams.set('client_id', clientInformation.client_id);
    authorizationUrl.searchParams.set('code_challenge', codeChallenge);
    authorizationUrl.searchParams.set('code_challenge_method', AUTHORIZATION_CODE_CHALLENGE_METHOD);
    authorizationUrl.searchParams.set('redirect_uri', String(redirectUrl));

    if (state) {
        authorizationUrl.searchParams.set('state', state);
    }

    if (scope) {
        authorizationUrl.searchParams.set('scope', scope);
    }

    if (scope?.split(' ').includes('offline_access')) {
        // if the request includes the OIDC-only "offline_access" scope,
        // we need to set the prompt to "consent" to ensure the user is prompted to grant offline access
        // https://openid.net/specs/openid-connect-core-1_0.html#OfflineAccess
        authorizationUrl.searchParams.append('prompt', 'consent');
    }

    if (resource) {
        authorizationUrl.searchParams.set('resource', resource.href);
    }

    return { authorizationUrl, codeVerifier };
}

/**
 * Prepares token request parameters for an authorization code exchange.
 *
 * This is the default implementation used by {@linkcode fetchToken} when the provider
 * doesn't implement {@linkcode OAuthClientProvider.prepareTokenRequest | prepareTokenRequest}.
 *
 * @param authorizationCode - The authorization code received from the authorization endpoint
 * @param codeVerifier - The PKCE code verifier
 * @param redirectUri - The redirect URI used in the authorization request
 * @returns URLSearchParams for the `authorization_code` grant
 */
export function prepareAuthorizationCodeRequest(
    authorizationCode: string,
    codeVerifier: string,
    redirectUri: string | URL
): URLSearchParams {
    return new URLSearchParams({
        grant_type: 'authorization_code',
        code: authorizationCode,
        code_verifier: codeVerifier,
        redirect_uri: String(redirectUri)
    });
}

/**
 * Internal helper to execute a token request with the given parameters.
 * Used by {@linkcode exchangeAuthorization}, {@linkcode refreshAuthorization}, and {@linkcode fetchToken}.
 */
export async function executeTokenRequest(
    authorizationServerUrl: string | URL,
    {
        metadata,
        tokenRequestParams,
        clientInformation,
        addClientAuthentication,
        resource,
        fetchFn,
        discoveryPolicy
    }: {
        metadata?: AuthorizationServerMetadata;
        tokenRequestParams: URLSearchParams;
        clientInformation?: OAuthClientInformationMixed;
        addClientAuthentication?: OAuthClientProvider['addClientAuthentication'];
        resource?: URL;
        fetchFn?: FetchLike;
        /**
         * Overrides for the URL policy applied to the token endpoint
         * ({@linkcode assertAllowedDiscoveryUrl}). **Policy-weakening**, default off.
         */
        discoveryPolicy?: DiscoveryUrlPolicyOptions;
    },
    /**
     * The provider's `validateDiscoveryURL` hook, threaded by the calling flow
     * entry. Trust flows only from the provider.
     *
     * @internal
     */
    validateDiscoveryURL?: ValidateDiscoveryUrlHook
): Promise<OAuthTokens> {
    // The scheme rule keeps its dedicated error type (SEP-2207); the full URL
    // policy — including the locality rules keyed on the authorization server
    // that published the endpoint — is applied inside the fetch path below,
    // before the request is sent.
    const tokenUrl = assertSecureTokenEndpoint(metadata?.token_endpoint ?? new URL('/token', authorizationServerUrl));

    const headers = new Headers({
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
    });

    if (resource) {
        tokenRequestParams.set('resource', resource.href);
    }

    if (addClientAuthentication) {
        await addClientAuthentication(headers, tokenRequestParams, tokenUrl, metadata);
    } else if (clientInformation) {
        const supportedMethods = metadata?.token_endpoint_auth_methods_supported ?? [];
        const authMethod = selectClientAuthMethod(clientInformation, supportedMethods);
        applyClientAuthentication(authMethod, clientInformation as OAuthClientInformation, headers, tokenRequestParams);
    }

    const response = await fetchDiscoveryUrl(tokenUrl, { method: 'POST', headers, body: tokenRequestParams }, fetchFn ?? fetch, {
        purpose: 'token-endpoint',
        source: metadata ? 'authorization-server-metadata' : 'sdk-derived',
        producer: { url: new URL(authorizationServerUrl), kind: 'authorization-server' },
        policy: discoveryPolicy,
        validate: validateDiscoveryURL
    });

    if (!response.ok) {
        throw await parseErrorResponse(response);
    }

    const json: unknown = await response.json();

    try {
        return OAuthTokensSchema.parse(json);
    } catch (parseError) {
        // Some OAuth servers (e.g., GitHub) return error responses with HTTP 200 status.
        // Check for error field only if token parsing failed.
        if (typeof json === 'object' && json !== null && 'error' in json) {
            throw await parseErrorResponse(JSON.stringify(json));
        }
        throw parseError;
    }
}

/**
 * Exchanges an authorization code for an access token with the given server.
 *
 * Supports multiple client authentication methods as specified in OAuth 2.1:
 * - Automatically selects the best authentication method based on server support
 * - Falls back to appropriate defaults when server metadata is unavailable
 *
 * @param authorizationServerUrl - The authorization server's base URL
 * @param options - Configuration object containing client info, auth code, etc.
 * @returns Promise resolving to OAuth tokens
 * @throws {Error} When token exchange fails or authentication is invalid
 */
export async function exchangeAuthorization(
    authorizationServerUrl: string | URL,
    {
        metadata,
        clientInformation,
        authorizationCode,
        iss,
        codeVerifier,
        redirectUri,
        resource,
        addClientAuthentication,
        fetchFn,
        discoveryPolicy
    }: {
        metadata?: AuthorizationServerMetadata;
        clientInformation: OAuthClientInformationMixed;
        authorizationCode: string;
        /**
         * The form-urldecoded `iss` query parameter from the authorization callback.
         * Validated per RFC 9207 §2.4 against `metadata.issuer` before the code is
         * redeemed; see {@linkcode validateAuthorizationResponseIssuer}.
         */
        iss?: string;
        codeVerifier: string;
        redirectUri: string | URL;
        resource?: URL;
        addClientAuthentication?: OAuthClientProvider['addClientAuthentication'];
        fetchFn?: FetchLike;
        /**
         * Overrides for the URL policy applied to the token endpoint
         * ({@linkcode assertAllowedDiscoveryUrl}). **Policy-weakening**, default off.
         */
        discoveryPolicy?: DiscoveryUrlPolicyOptions;
    }
): Promise<OAuthTokens> {
    validateAuthorizationResponseIssuer({
        iss,
        expectedIssuer: metadata?.issuer,
        issParameterSupported: isIssParameterSupported(metadata)
    });

    const tokenRequestParams = prepareAuthorizationCodeRequest(authorizationCode, codeVerifier, redirectUri);

    return executeTokenRequest(authorizationServerUrl, {
        metadata,
        tokenRequestParams,
        clientInformation,
        addClientAuthentication,
        resource,
        fetchFn,
        discoveryPolicy
    });
}

/**
 * Exchange a refresh token for an updated access token.
 *
 * Supports multiple client authentication methods as specified in OAuth 2.1:
 * - Automatically selects the best authentication method based on server support
 * - Preserves the original refresh token if a new one is not returned
 *
 * @param authorizationServerUrl - The authorization server's base URL
 * @param options - Configuration object containing client info, refresh token, etc.
 * @returns Promise resolving to OAuth tokens (preserves original `refresh_token` if not replaced)
 * @throws {Error} When token refresh fails or authentication is invalid
 */
export async function refreshAuthorization(
    authorizationServerUrl: string | URL,
    options: {
        metadata?: AuthorizationServerMetadata;
        clientInformation: OAuthClientInformationMixed;
        refreshToken: string;
        resource?: URL;
        addClientAuthentication?: OAuthClientProvider['addClientAuthentication'];
        fetchFn?: FetchLike;
        /**
         * Overrides for the URL policy applied to the token endpoint
         * ({@linkcode assertAllowedDiscoveryUrl}). **Policy-weakening**, default off.
         */
        discoveryPolicy?: DiscoveryUrlPolicyOptions;
    }
): Promise<OAuthTokens> {
    return refreshAuthorizationInternal(authorizationServerUrl, options);
}

/**
 * {@linkcode refreshAuthorization} with the provider's `validateDiscoveryURL`
 * hook threaded by the calling flow entry ({@linkcode auth} / a transport).
 * Trust flows only from the provider, so the hook rides this internal variant
 * rather than the public signature — direct callers configure it on the
 * provider they hand to those entries.
 */
async function refreshAuthorizationInternal(
    authorizationServerUrl: string | URL,
    {
        metadata,
        clientInformation,
        refreshToken,
        resource,
        addClientAuthentication,
        fetchFn,
        discoveryPolicy
    }: Parameters<typeof refreshAuthorization>[1],
    validateDiscoveryURL?: ValidateDiscoveryUrlHook
): Promise<OAuthTokens> {
    const tokenRequestParams = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken
    });

    const tokens = await executeTokenRequest(
        authorizationServerUrl,
        {
            metadata,
            tokenRequestParams,
            clientInformation,
            addClientAuthentication,
            resource,
            fetchFn,
            discoveryPolicy
        },
        validateDiscoveryURL
    );

    // Preserve original refresh token if server didn't return a new one
    return { refresh_token: refreshToken, ...tokens };
}

/**
 * Unified token fetching that works with any grant type via {@linkcode OAuthClientProvider.prepareTokenRequest | prepareTokenRequest()}.
 *
 * This function provides a single entry point for obtaining tokens regardless of the
 * OAuth grant type. The provider's `prepareTokenRequest()` method determines which grant
 * to use and supplies the grant-specific parameters.
 *
 * @param provider - OAuth client provider that implements `prepareTokenRequest()`
 * @param authorizationServerUrl - The authorization server's base URL
 * @param options - Configuration for the token request
 * @returns Promise resolving to OAuth tokens
 * @throws {Error} When provider doesn't implement `prepareTokenRequest` or token fetch fails
 *
 * @example
 * ```ts source="./auth.examples.ts#fetchToken_clientCredentials"
 * // Provider for client_credentials:
 * class MyProvider extends MyProviderBase implements OAuthClientProvider {
 *     prepareTokenRequest(scope?: string) {
 *         const params = new URLSearchParams({ grant_type: 'client_credentials' });
 *         if (scope) params.set('scope', scope);
 *         return params;
 *     }
 * }
 *
 * const tokens = await fetchToken(new MyProvider(), authServerUrl, { metadata });
 * ```
 */
export async function fetchToken(
    provider: OAuthClientProvider,
    authorizationServerUrl: string | URL,
    {
        metadata,
        resource,
        authorizationCode,
        iss,
        scope,
        fetchFn,
        discoveryPolicy
    }: {
        metadata?: AuthorizationServerMetadata;
        resource?: URL;
        /** Authorization code for the default `authorization_code` grant flow */
        authorizationCode?: string;
        /**
         * The form-urldecoded `iss` query parameter from the authorization callback.
         * Validated per RFC 9207 §2.4 when `authorizationCode` is present;
         * see {@linkcode validateAuthorizationResponseIssuer}.
         */
        iss?: string;
        /** Optional scope parameter from auth() options */
        scope?: string;
        fetchFn?: FetchLike;
        /**
         * Overrides for the URL policy applied to the token endpoint
         * ({@linkcode assertAllowedDiscoveryUrl}). **Policy-weakening**, default off.
         * Defaults to the provider's {@linkcode OAuthClientProvider.discoveryPolicy}.
         */
        discoveryPolicy?: DiscoveryUrlPolicyOptions;
    } = {}
): Promise<OAuthTokens> {
    // Effective policy resolved once at this flow entry: per-call options take
    // precedence over the provider's durable policy. The provider's trust hook is
    // threaded to the token-endpoint checkpoint the same way.
    discoveryPolicy ??= provider.discoveryPolicy;
    const validateDiscoveryURL = provider.validateDiscoveryURL?.bind(provider);

    if (authorizationCode !== undefined) {
        validateAuthorizationResponseIssuer({
            iss,
            expectedIssuer: metadata?.issuer,
            issParameterSupported: isIssParameterSupported(metadata)
        });
    }

    // Prefer scope from options, fallback to provider.clientMetadata.scope
    const effectiveScope = scope ?? provider.clientMetadata.scope;

    // Use provider's prepareTokenRequest if available, otherwise fall back to authorization_code
    let tokenRequestParams: URLSearchParams | undefined;
    if (provider.prepareTokenRequest) {
        tokenRequestParams = await provider.prepareTokenRequest(effectiveScope);
    }

    // Default to authorization_code grant if no custom prepareTokenRequest
    if (!tokenRequestParams) {
        if (!authorizationCode) {
            throw new Error('Either provider.prepareTokenRequest() or authorizationCode is required');
        }
        if (!provider.redirectUrl) {
            throw new Error('redirectUrl is required for authorization_code flow');
        }
        const codeVerifier = await provider.codeVerifier();
        tokenRequestParams = prepareAuthorizationCodeRequest(authorizationCode, codeVerifier, provider.redirectUrl);
    }

    const clientInformation = await provider.clientInformation({ issuer: metadata?.issuer ?? String(authorizationServerUrl) });

    return executeTokenRequest(
        authorizationServerUrl,
        {
            metadata,
            tokenRequestParams,
            clientInformation: clientInformation ?? undefined,
            addClientAuthentication: provider.addClientAuthentication,
            resource,
            fetchFn,
            discoveryPolicy
        },
        validateDiscoveryURL
    );
}

/**
 * Performs OAuth 2.0 Dynamic Client Registration according to
 * {@link https://datatracker.ietf.org/doc/html/rfc7591 | RFC 7591}.
 *
 * If `scope` is provided, it overrides `clientMetadata.scope` in the registration
 * request body. This allows callers to apply the Scope Selection Strategy (SEP-835)
 * consistently across both DCR and the subsequent authorization request.
 *
 * @deprecated Dynamic Client Registration is deprecated as of protocol version
 * 2026-07-28 (SEP-2577) in favor of Client ID Metadata Documents (SEP-991).
 * Remains functional during the deprecation window (at least twelve months).
 * Prefer a CIMD URL `client_id` when the authorization server advertises
 * `client_id_metadata_document_supported`; the SDK already gates on this for you.
 */
export async function registerClient(
    authorizationServerUrl: string | URL,
    options: {
        metadata?: AuthorizationServerMetadata;
        clientMetadata: OAuthClientMetadata;
        scope?: string;
        fetchFn?: FetchLike;
        /**
         * Overrides for the URL policy applied to the registration endpoint
         * ({@linkcode assertAllowedDiscoveryUrl}). **Policy-weakening**, default off.
         */
        discoveryPolicy?: DiscoveryUrlPolicyOptions;
    }
): Promise<OAuthClientInformationFull> {
    return registerClientInternal(authorizationServerUrl, options);
}

/**
 * {@linkcode registerClient} with the provider's `validateDiscoveryURL` hook
 * threaded by the calling flow entry ({@linkcode auth} / a transport). Trust
 * flows only from the provider, so the hook rides this internal variant rather
 * than the public signature — direct callers configure it on the provider they
 * hand to those entries.
 */
async function registerClientInternal(
    authorizationServerUrl: string | URL,
    { metadata, clientMetadata, scope, fetchFn, discoveryPolicy }: Parameters<typeof registerClient>[1],
    validateDiscoveryURL?: ValidateDiscoveryUrlHook
): Promise<OAuthClientInformationFull> {
    let registrationUrl: URL;

    if (metadata) {
        if (!metadata.registration_endpoint) {
            throw new Error('Incompatible auth server: does not support dynamic client registration');
        }

        registrationUrl = new URL(metadata.registration_endpoint);
    } else {
        registrationUrl = new URL('/register', authorizationServerUrl);
    }

    // `clientMetadata` arrives via resolveClientMetadata() inside auth(), so the
    // SEP-837/2207 defaults are already applied. Direct callers that want the
    // same defaults should pass resolveClientMetadata(provider) here.
    const submittedMetadata: OAuthClientMetadata = {
        ...clientMetadata,
        ...(scope === undefined ? {} : { scope })
    };

    // The endpoint is validated inside the fetch path before the registration
    // request is sent — the same https-or-loopback and locality rules as the
    // token endpoint (SEP-2207), keyed on the authorization server that
    // published the endpoint.
    const response = await fetchDiscoveryUrl(
        registrationUrl,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(submittedMetadata) },
        fetchFn ?? fetch,
        {
            purpose: 'registration-endpoint',
            source: metadata ? 'authorization-server-metadata' : 'sdk-derived',
            producer: { url: new URL(authorizationServerUrl), kind: 'authorization-server' },
            policy: discoveryPolicy,
            validate: validateDiscoveryURL
        }
    );

    if (!response.ok) {
        throw new RegistrationRejectedError({ status: response.status, body: await response.text(), submittedMetadata });
    }

    return OAuthClientInformationFullSchema.parse(await response.json());
}
