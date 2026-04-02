---
'@modelcontextprotocol/client': minor
---

Add `validateClientMetadataUrl()` utility for early validation of `clientMetadataUrl`

Exports a `validateClientMetadataUrl()` function that `OAuthClientProvider` implementations
can call in their constructors to fail fast on invalid URL-based client IDs, instead of
discovering the error deep in the auth flow.
