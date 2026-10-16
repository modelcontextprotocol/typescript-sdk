### Auth

#### OAuth error consolidation

The individual OAuth error classes are replaced with a single `OAuthError` + `OAuthErrorCode`.
The `OAUTH_ERRORS` constant is removed. The codemod does not rewrite `instanceof` checks
on these classes — switch on `error.code` instead.

| v1 class                       | v2 equivalent                                           |
| ------------------------------ | ------------------------------------------------------- |
| `InvalidRequestError`          | `OAuthError` + `OAuthErrorCode.InvalidRequest`          |
| `InvalidClientError`           | `OAuthError` + `OAuthErrorCode.InvalidClient`           |
| `InvalidGrantError`            | `OAuthError` + `OAuthErrorCode.InvalidGrant`            |
| `UnauthorizedClientError`      | `OAuthError` + `OAuthErrorCode.UnauthorizedClient`      |
| `UnsupportedGrantTypeError`    | `OAuthError` + `OAuthErrorCode.UnsupportedGrantType`    |
| `InvalidScopeError`            | `OAuthError` + `OAuthErrorCode.InvalidScope`            |
| `AccessDeniedError`            | `OAuthError` + `OAuthErrorCode.AccessDenied`            |
| `ServerError`                  | `OAuthError` + `OAuthErrorCode.ServerError`             |
| `TemporarilyUnavailableError`  | `OAuthError` + `OAuthErrorCode.TemporarilyUnavailable`  |
| `UnsupportedResponseTypeError` | `OAuthError` + `OAuthErrorCode.UnsupportedResponseType` |
| `UnsupportedTokenTypeError`    | `OAuthError` + `OAuthErrorCode.UnsupportedTokenType`    |
| `InvalidTokenError`            | `OAuthError` + `OAuthErrorCode.InvalidToken`            |
| `MethodNotAllowedError`        | `OAuthError` + `OAuthErrorCode.MethodNotAllowed`        |
| `TooManyRequestsError`         | `OAuthError` + `OAuthErrorCode.TooManyRequests`         |
| `InvalidClientMetadataError`   | `OAuthError` + `OAuthErrorCode.InvalidClientMetadata`   |
| `InsufficientScopeError`       | `OAuthError` + `OAuthErrorCode.InsufficientScope` ¹     |
| `InvalidTargetError`           | `OAuthError` + `OAuthErrorCode.InvalidTarget`           |
| `CustomOAuthError`             | `new OAuthError(customCode, message)`                   |

¹ Unrelated to the new transport-layer `InsufficientScopeError` (SEP-2350) exported from
`@modelcontextprotocol/client`, which carries an RFC 6750 challenge from the resource
server and extends `OAuthClientFlowError`, **not** `OAuthError`. Do not rewrite that one.

```typescript
// v1
if (error instanceof InvalidClientError) { ... }
// v2
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/client';
if (error instanceof OAuthError && error.code === OAuthErrorCode.InvalidClient) { ... }
```

⚠ **Token verifiers must throw the v2 `OAuthError`.** `requireBearerAuth` (from
`@modelcontextprotocol/express`, or from `@modelcontextprotocol/server` on
web-standard hosts) classifies the error your
`OAuthTokenVerifier.verifyAccessToken()` throws: a v2
`OAuthError(OAuthErrorCode.InvalidToken)` produces the proper `401` +
`WWW-Authenticate` challenge, while the legacy `InvalidTokenError` (from
`server-legacy`) or a generic `Error` falls through as unexpected — **invalid tokens
become HTTP `500`**. When you re-point `requireBearerAuth` at
`@modelcontextprotocol/express`, migrate the error classes your verifier throws in the
same change.

A frozen copy of the v1 classes (and `mcpAuthRouter`) is available from
`@modelcontextprotocol/server-legacy/auth` during migration.

#### `AuthProvider` — non-OAuth bearer auth and the widened `authProvider` option

The transport `authProvider` option is widened to `AuthProvider | OAuthClientProvider`.
**`AuthProvider`** is a new minimal interface — `{ token(): Promise<string | undefined>;
onUnauthorized?(ctx): Promise<void> }` — for static-token / non-OAuth bearer auth.
Transports call `token()` before every request and `onUnauthorized()` on 401 (then retry
once). Existing `OAuthClientProvider` implementations need no changes — transports adapt
them internally via the new `adaptOAuthProvider()` export. Also exported:
`isOAuthClientProvider()` (type guard) and `handleOAuthUnauthorized()` (the standard
OAuth `onUnauthorized` behavior, for composing your own adapter).

#### OAuth client flow — behavioral changes

- **Resolved scope passed to DCR (SEP-835).** `auth()` now computes the resolved scope
  once (WWW-Authenticate → PRM `scopes_supported` → `clientMetadata.scope`) and passes
  it to **both** the DCR POST body and the authorization request. `registerClient()`
  gained an optional `scope` parameter that overrides `clientMetadata.scope` in the
  registration body.
- **OAuth error on HTTP 200.** `exchangeAuthorization()` / `refreshAuthorization()` now
  throw `OAuthError` when the AS returns HTTP 200 with a JSON `{error: ...}` body (e.g.
  GitHub). v1 surfaced this as a Zod parse failure on the tokens schema.
- **Metadata discovery falls through on 502.** `discoverAuthorizationServerMetadata()`
  treats `502 Bad Gateway` like 4xx — fall through to the next candidate URL instead of
  throwing (fixes path-aware discovery behind reverse proxies). Other 5xx still throw.
- **Scoped credential invalidation on `invalid_client` / `unauthorized_client`.** The
  `auth()` retry for these errors now issues two scoped calls —
  `invalidateCredentials('client')` then `invalidateCredentials('tokens')` — instead of
  v1's single `invalidateCredentials('all')`, deliberately preserving the stored
  discovery state so the callback-leg check on retry does not mask the original error.
  A provider whose `invalidateCredentials()` implementation special-cases the `'all'`
  scope must handle the split calls.
- **Token persistence failures after a refresh now propagate.** v1 wrapped both
  `refreshAuthorization()` and the `saveTokens()` that persists its result in one
  `try`/`catch`, so a provider's persistence error was discarded alongside AS-side refresh
  failures and `auth()` fell through to a fresh authorization request, returning
  `'REDIRECT'`. Only the refresh call is guarded now — persisting runs after it and rejects
  to the caller. Against an AS that rotates refresh tokens this was destructive rather than
  merely quiet: the exchange has already succeeded, so the old refresh token is invalidated
  server-side the moment the new one is issued, and dropping the new token set leaves
  nothing usable on either side. A provider whose `saveTokens()` can throw (transient
  storage errors, file-lock contention) must handle the rejection from `auth()` — and from
  the transport 401-retry paths built on it — where v1 silently re-authorized. Refresh
  failures themselves keep their control flow: a `ServerError` or an unknown error still
  falls through to a new authorization request, and `invalid_grant` / `invalid_client` /
  `unauthorized_client` are still recovered by discarding stored credentials and retrying.
  Both routes now emit a `console.warn` naming the cause, so an unexplained re-auth prompt
  can be traced to the failure that triggered it.

#### OAuth client flow errors (new)

The OAuth client flow now throws dedicated classes from `@modelcontextprotocol/client`
(all extend `OAuthClientFlowError`, **not** `OAuthError` — `auth()`'s `OAuthError` retry
path will not catch them):

| Throw site                                                                                                                | v2 class                                                                              |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `registerClient()` rejected by AS (⚠ `@deprecated` — see [§Deprecated in v2](protocol-ctx.md#deprecated-in-v2-sep-2577)) | `RegistrationRejectedError` (`status`, `body`, `submittedMetadata`)                   |
| Token-exchange / refresh / `fetchToken` / Cross-App grant on a non-`https:` token endpoint                                | `InsecureTokenEndpointError` (`tokenEndpoint`)                                        |
| RFC 9207 `iss` mismatch / RFC 8414 §3.3 issuer-echo mismatch                                                              | `IssuerMismatchError` (`kind`, `expected`, `received`)                                |
| Transport 403 `insufficient_scope` with `onInsufficientScope: 'throw'`, or default mode without an `OAuthClientProvider`  | `InsufficientScopeError` (`requiredScope`, `resourceMetadataUrl`, `errorDescription`) |
| `auth()` callback leg: discovery resolves a different AS than the recorded redirect target                                | `AuthorizationServerMismatchError` (`recordedIssuer`, `currentIssuer`)                |
| `auth()` on a provider that cannot re-register, or `fetchToken()`: client information stamped for a different AS          | `AuthorizationServerMismatchError` (`recordedIssuer`, `currentIssuer`)                |

#### Connect-time OAuth retry (`UnauthorizedError`)

`UnauthorizedError` survives in v2 (exported from `@modelcontextprotocol/client` —
its only appearance in the error table above is the removed `SSEClientTransport.send()`
401 path), and the v1 connect-time pattern carries over: catch it from `connect()`,
complete the browser flow, call `transport.finishAuth(…)`, reconnect.

```typescript
try {
    await client.connect(transport);
} catch (error) {
    if (!(error instanceof UnauthorizedError)) throw error;
    // provider.redirectToAuthorization() has been called; complete the flow,
    // then reconnect on a FRESH transport (a started transport cannot be restarted).
    await transport.finishAuth(new URL(callbackUrl).searchParams);
    await client.connect(new StreamableHTTPClientTransport(url, { authProvider: provider }));
}
```

This direct `instanceof` check works in every version-negotiation mode: under the
probing modes (`versionNegotiation: { mode: 'auto' }`, with or without a pin) the
connect-time `UnauthorizedError` also propagates unchanged from `connect()`. Older
releases wrapped it as `SdkError(SdkErrorCode.EraNegotiationFailed)` with the error at
`error.data.cause` — that unwrap is no longer needed. See the
[client OAuth guide](https://ts.sdk.modelcontextprotocol.io/v2/clients/oauth.md).

#### `auth()` options are now `AuthOptions`

The inline options object on `auth()` is now the named `AuthOptions` type. New fields:
`iss?: string` (the form-urldecoded `iss` from the authorization callback — pass it
alongside `authorizationCode` for RFC 9207 validation), `skipIssuerMetadataValidation?:
boolean` (security-weakening opt-out of the RFC 8414 §3.3 issuer-echo check), and
`forceReauthorization?: boolean` (skip the refresh-token branch — set by the transport's
step-up path; hosts driving step-up themselves set it under the same condition).

#### Authorization-server mix-up defense (RFC 9207 / RFC 8414 §3.3) — action required

`transport.finishAuth()` and `auth()` now validate `iss` from the authorization callback
against the issuer recorded from validated AS metadata. A mismatched `iss` throws
`IssuerMismatchError` before the code is exchanged regardless of advertised support; a
**missing** `iss` throws only when the AS advertised
`authorization_response_iss_parameter_supported: true`.

Pass the callback URL's `URLSearchParams` so the SDK can read `iss` alongside `code`.
The SDK does **not** validate `state`; compare it yourself before calling `finishAuth`:

```typescript
const params = new URL(callbackUrl).searchParams;
if (params.get('state') !== expectedState) throw new Error('state mismatch');
await transport.finishAuth(params); // SDK reads `code` + `iss`
```

`transport.finishAuth(code, iss)` remains supported. Do **not** display `error` /
`error_description` / `error_uri` from a callback that failed `iss` validation — those
values are attacker-controlled in a mix-up attack.

`discoverAuthorizationServerMetadata()` now rejects metadata whose `issuer` does not
exactly match the URL it was fetched for (RFC 8414 §3.3). Set
`skipIssuerMetadataValidation: true` only as a temporary workaround for a known-misconfigured AS.

(`@modelcontextprotocol/server-legacy` AS implementers: `mcpAuthRouter()` now advertises
`authorization_response_iss_parameter_supported: true` by default and the bundled
authorize handler appends `iss` to every redirect issued via `res.redirect(...)` on the
supplied `res`. If you emit `Location` another way, append `params.issuer` as `iss`
yourself; if your callback is issued by an upstream AS you proxy to, set
`authorizationResponseIssParameterSupported = false` so the metadata does not over-claim.)

#### Dynamic Client Registration defaults (SEP-837, SEP-2207)

`auth()` now resolves `provider.clientMetadata` once via `resolveClientMetadata()` and
applies defaults to the DCR body: `grant_types` defaults to
`['authorization_code', 'refresh_token']`; `application_type` is derived from
`redirect_uris` (loopback / custom URI scheme → `'native'`, else `'web'`). A field you
set explicitly is never overwritten. The `grant_types` default applies to the DCR body
only — it does **not** drive the `offline_access` / `prompt=consent` augmentation on the
authorize request; statically-registered and CIMD clients that want that augmentation
must set `clientMetadata.grant_types` explicitly. Non-interactive providers (no
`redirectUrl`) get no `grant_types` default. Direct `registerClient()` callers (⚠
`@deprecated` — see [§Deprecated in v2](protocol-ctx.md#deprecated-in-v2-sep-2577)) wanting the same
defaults pass `resolveClientMetadata(provider)` as `clientMetadata`. DCR
rejection now throws `RegistrationRejectedError` (carrying `status`, `body`,
`submittedMetadata`).

#### Token endpoint must use TLS (SEP-2207)

`exchangeAuthorization()`, `refreshAuthorization()`, `fetchToken()`, and the Cross-App
Access helpers throw `InsecureTokenEndpointError` when the token endpoint is not
`https:` (loopback `localhost` / `*.localhost` / `127.0.0.1` / `::1` exempt). `auth()` surfaces this on
every path including refresh — switch any plain-`http:` AS on a non-loopback host to
TLS; there is no opt-out. Storage confidentiality of `refresh_token` remains your
`saveTokens()` implementation's responsibility.

#### Scope step-up on `403 insufficient_scope` (SEP-2350)

`StreamableHTTPClientTransport` accepts `onInsufficientScope: 'reauthorize' | 'throw'`
(default `'reauthorize'`). On `'reauthorize'` the transport re-authorizes with the
**union** of the previously-requested and challenged scope (`computeScopeUnion`); when
that union strictly exceeds the current token's granted scope (`isStrictScopeSuperset`),
the SDK bypasses the refresh-token branch and forces a fresh authorization request. On
`'throw'` the transport raises `InsufficientScopeError` and does not re-authorize — set
this for `client_credentials` / m2m clients where re-authorization can't widen scope, or
to gate the consent prompt behind UX. Step-up retries are hard-capped per send
(`maxStepUpRetries`, default 1). With a non-OAuth [`AuthProvider`](#authprovider--non-oauth-bearer-auth-and-the-widened-authprovider-option),
a `403 insufficient_scope` now throws `InsufficientScopeError` instead of the previous
`SdkHttpError(ClientHttpNotImplemented)`. The GET listen-stream open path applies the
same handling as the POST send path.

#### Credentials bound to the issuing authorization server (SEP-2352)

`auth()` stamps an `issuer` field onto every value it passes to `saveTokens()` /
`saveClientInformation()` and threads `{ issuer }` as the `ctx` argument to those
methods plus `tokens()` / `clientInformation()`. On read, a stored value whose `issuer`
names a different AS is treated as `undefined` and the flow re-registers / re-authorizes
(or throws `AuthorizationServerMismatchError` when the provider has no `saveClientInformation()`).
**Round-trip the stored object verbatim and you're protected** — single-slot storage
works. Dropping the stamp is easy to miss: a `saveTokens()` implementation that
rebuilds the object field-by-field and drops `issuer` leaves the value unstamped —
reads still succeed and refresh keeps working, the per-AS issuer check simply does not
apply to that credential, and every read logs an `[mcp-sdk]` warning (`auth()`
re-stamps on first use where the provider can persist it). If you see that warning
repeating after upgrading, check this first. To hold credentials for several authorization servers at once, key your storage
on `ctx.issuer` (treat **`ctx === undefined` as "return the most-recently-saved token
set"** — the transport's per-request `Authorization: Bearer` read calls `tokens()` with
no `ctx`). `OAuthTokensSchema` / `OAuthClientInformationSchema` keep the optional `issuer`, so
reading storage back through them is fine; the `StoredOAuthTokens` / `StoredOAuthClientInformation`
aliases name the stored shape.

`OAuthClientProvider.saveAuthorizationServerUrl()` / `authorizationServerUrl()` are
`@deprecated` (still written for back-compat, never read by the SDK). The bundled
`ClientCredentialsProvider`, `PrivateKeyJwtProvider`, `StaticPrivateKeyJwtProvider`, and
`CrossAppAccessProvider` gain `expectedIssuer?: string` (omitting it is deprecated) and no
longer define `saveClientInformation()`. Implement `discoveryState()` / `saveDiscoveryState()` so the
callback leg can verify it is exchanging the code at the same AS the redirect targeted;
without it the SDK `console.warn`s once per callback (`discoveryState` must persist with
the same durability as `codeVerifier`). Both methods are optional on
`OAuthClientProvider` and may be sync or async; `OAuthDiscoveryState` (exported from
`@modelcontextprotocol/client`) extends `OAuthServerInfo` with the optional
`resourceMetadataUrl` the protected-resource metadata was found at:

```typescript
import type { OAuthDiscoveryState } from '@modelcontextprotocol/client';

// On OAuthClientProvider:
saveDiscoveryState?(state: OAuthDiscoveryState): void | Promise<void>;
discoveryState?(): OAuthDiscoveryState | undefined | Promise<OAuthDiscoveryState | undefined>;
```

#### Conformance obligations for `OAuthClientProvider` implementers

The SDK enforces every authorization MUST that lands in SDK code. The following live in
**your** implementation and the SDK structurally cannot enforce them:

- **Round-trip the `issuer` stamp** on persisted credentials (SEP-2352). Persist the
  value verbatim from `saveTokens` / `saveClientInformation` and return it verbatim.
- **Pass `expectedIssuer`** when constructing static-credential providers (SEP-2352).
- **Keep refresh tokens confidential in storage** (SEP-2207) — OS keychain or
  encrypted-at-rest store, never `localStorage` / plain files / logs.
- **Extract `iss` from the callback URL** and pass it to `finishAuth` (SEP-2468); when
  `IssuerMismatchError` is thrown, do not render the callback's `error*` values.
- **Set `application_type` correctly** when overriding the heuristic (SEP-837).
- **Track cross-request step-up failures yourself** (SEP-2350) — `maxStepUpRetries` is
  per request; per-session backoff is host state.
- **Persist discovery state**: implement `discoveryState()` / `saveDiscoveryState()` so
  the authorization-server metadata your tokens were issued against survives restarts.
- **Choose the insufficient-scope behavior**: keep the default
  `onInsufficientScope: 'reauthorize'`, or handle `InsufficientScopeError` yourself.
- **Resource-server operators: do not advertise `offline_access`** in `WWW-Authenticate`
  `scope` or PRM `scopes_supported` (SEP-2207).
