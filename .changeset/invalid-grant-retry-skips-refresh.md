---
'@modelcontextprotocol/client': patch
---

When a refresh fails with `invalid_grant` or `invalid_dpop_proof`, `auth()` now retries with a new authorization request instead of sending the rejected refresh token again. Before this change, a provider that does not implement `invalidateCredentials()` still returned the rejected refresh token from `tokens()`, so the retry refreshed with it a second time and `auth()` threw the authorization server's error instead of returning `'REDIRECT'`. Providers that implement `invalidateCredentials()` behave as before.
