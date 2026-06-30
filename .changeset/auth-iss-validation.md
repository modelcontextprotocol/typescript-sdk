---
'@modelcontextprotocol/core-internal': minor
'@modelcontextprotocol/client': minor
---

Implement RFC 9207 / RFC 8414 §3.3 OAuth issuer validation (SEP-2468). `discoverAuthorizationServerMetadata()` now rejects metadata whose `issuer` does not match the discovery URL (opt out via `skipIssuerValidation` / `AuthOptions.skipIssuerMetadataValidation` — security-weakening). `auth()`, `exchangeAuthorization()`, `fetchToken()`, and `transport.finishAuth(code, iss?)` now validate the authorization-callback `iss` against the recorded issuer before redeeming the code; new `IssuerMismatchError` and `validateAuthorizationResponseIssuer()` are exported.
