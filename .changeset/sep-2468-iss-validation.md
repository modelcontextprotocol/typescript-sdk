---
'@modelcontextprotocol/core': patch
'@modelcontextprotocol/client': minor
---

Add RFC 9207 `iss` parameter validation for authorization responses (SEP-2468). `OAuthMetadataSchema` and `OpenIdProviderMetadataSchema` now recognize `authorization_response_iss_parameter_supported`. The client exports a new `validateAuthorizationResponseIssuer()` helper, `auth()` accepts an optional `iss`, and `StreamableHTTPClientTransport.finishAuth()` / `SSEClientTransport.finishAuth()` accept an optional `{ iss }` second argument. When provided, the `iss` from the authorization response is validated against the issuer recorded in the authorization server metadata before the authorization code is sent to any token endpoint; on mismatch the response is rejected without processing any other response parameters. All additions are backwards-compatible.
