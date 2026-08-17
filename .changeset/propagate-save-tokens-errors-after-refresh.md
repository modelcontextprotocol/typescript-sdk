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
SEP-2352 `issuer` stamp written with the refreshed tokens is unchanged. That fallthrough
no longer happens in total silence, though — it now emits a `console.warn` naming the
cause, so the re-authorization prompt a user sees can be traced back to the failed refresh.

Consumers whose `OAuthClientProvider.saveTokens` can reject should note that `auth()` may
now reject where it previously returned `'REDIRECT'` — that rejection is the failure that
was being discarded.
