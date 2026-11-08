---
'@modelcontextprotocol/client': patch
---

`auth()` no longer sends a refresh token to the token endpoint again after the authorization server rejected it with `invalid_grant` or `invalid_dpop_proof`. It remembers the rejected token per provider and goes straight to a new authorization, both in the immediate retry and in later `auth()` calls, until a different refresh token is stored. Before this change, a provider that does not implement `invalidateCredentials()` kept returning the rejected token from `tokens()`, so the retry refreshed with it a second time and `auth()` threw the authorization server's error instead of returning `'REDIRECT'`. Providers that implement `invalidateCredentials()` behave as before.
