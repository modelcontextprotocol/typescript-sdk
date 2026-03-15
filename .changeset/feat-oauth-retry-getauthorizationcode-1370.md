---
'@modelcontextprotocol/client': minor
---

Add `getAuthorizationCode()` to `OAuthClientProvider` for headless OAuth flows

The `withOAuth` middleware now supports completing the authorization code exchange
automatically when the provider implements the new optional `getAuthorizationCode()`
method. This enables headless environments (CI, test harnesses, CLI tools) where the
OAuth redirect can be intercepted programmatically.

Additionally, `withOAuth` now handles `403` responses the same as `401`, since a 403
can indicate the server requires a broader scope (upscoping).
