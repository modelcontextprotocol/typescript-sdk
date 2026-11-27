---
'@modelcontextprotocol/client': patch
---

Retry the `refresh_token` grant on transient failures instead of starting a new authorization (#3238).

`auth()` used to treat a network error, a timeout, or an authorization server answering HTTP 5xx / 429 / `server_error` / `temporarily_unavailable` during refresh the same way it treats a revoked refresh token: it warned, then fell through to `redirectToAuthorization()`. On a headless client that surfaces as `UnauthorizedError` and drops a connection whose credentials were fine. The refresh grant is now retried up to twice with exponential backoff and jitter — each attempt re-enters `refreshAuthorization()`, so DPoP proofs and `private_key_jwt` assertions are minted fresh — and if it still fails, `auth()` throws the new `TransientRefreshError` (carrying the last failure as `cause`) while keeping the stored refresh token, so the caller can retry later.

Breaking: a `server_error` or network failure during refresh no longer resolves `'REDIRECT'` and no longer reaches `redirectToAuthorization()`; handle `TransientRefreshError` where you handled that fallback. Definitive rejections are unchanged — `invalid_grant`, `invalid_client`, `unauthorized_client` and `invalid_dpop_proof` still invalidate credentials and start a new authorization, `InsecureTokenEndpointError` still propagates, and the `authorization_code` exchange and `client_credentials` grants are still never retried.
