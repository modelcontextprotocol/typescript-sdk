---
'@modelcontextprotocol/client': patch
---

Let `saveTokens` failures surface after a successful token refresh. In `auth()`, one `try`
wrapped both `refreshAuthorization()` and the `provider.saveTokens()` that persists its
result, and the `catch` deliberately swallows anything that is not an `OAuthError` — plus
`ServerError` — so that a failed refresh falls through to a fresh authorization request.
A persistence error thrown by the provider landed in that same branch: it was discarded
with no log and no rethrow, and `auth()` continued to `startAuthorization()` and returned
`'REDIRECT'`.

Against an authorization server that rotates refresh tokens (the OAuth 2.1 default, and
Keycloak's) this loses credentials rather than merely hiding an error. The exchange has
already succeeded server-side, so the old refresh token is invalidated at the moment the
new one is issued; dropping the new token set leaves nothing usable on either side. On a
headless or CLI client, where `redirectToAuthorization` is typically a no-op, the fallthrough
is silent and the client is left with stale tokens and no indication of why.

The `try`/`catch` now covers only `refreshAuthorization()`. Persisting the result happens
after it, on an unguarded path, so a provider's I/O error propagates to the caller.

Refresh-request failures keep their existing control flow exactly: a `ServerError` or an
unknown error still falls through to a new authorization flow, a non-`ServerError`
`OAuthError` is still rethrown, and `InsecureTokenEndpointError` is still surfaced. The
SEP-2352 `issuer` stamp written with the refreshed tokens is unchanged.

Those fallbacks no longer happen in silence, though. Both routes to an unexplained
re-authorization now emit a `console.warn` naming the cause: the in-place fallthrough in
the refresh block, and `auth()`'s outer recovery for `invalid_grant`, `invalid_client`,
and `unauthorized_client`, which discards stored credentials and retries. The second one
matters most in practice — an expired, revoked, or rotation-reuse-detected refresh token
is reported as `invalid_grant`, which is precisely the state a dropped token set leaves
behind for the next call.

Consumers whose `OAuthClientProvider.saveTokens` can reject should note that `auth()` may
now reject where it previously returned `'REDIRECT'` — that rejection is the failure that
was being discarded.
