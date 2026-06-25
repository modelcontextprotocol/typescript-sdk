---
'@modelcontextprotocol/core': patch
'@modelcontextprotocol/client': minor
---

Add RFC 9207 `iss` parameter validation for authorization responses (SEP-2468). `OAuthMetadataSchema` and `OpenIdProviderMetadataSchema` now recognize `authorization_response_iss_parameter_supported`. The client exports a new `validateAuthorizationResponseIssuer()` helper,
`auth()` accepts an optional `iss`, and `StreamableHTTPClientTransport.finishAuth()` / `SSEClientTransport.finishAuth()` accept an optional `{ iss }` second argument. The `iss` option is tri-state: a string is validated by exact comparison against the issuer recorded in the
authorization server metadata before the authorization code is sent to any token endpoint (mismatch rejects the response without processing any other response parameters); `null` asserts the caller inspected the authorization response and it carried no `iss`, enabling the RFC
9207 fail-closed rejection when the AS advertises `authorization_response_iss_parameter_supported: true`; `undefined` (omitted) skips RFC 9207 response validation, so existing `finishAuth(code)` callers that never see the authorization response are unaffected.

Discovery also now validates authorization-server metadata issuer values per RFC 8414 Section 3.3. Metadata discovered for a PRM-provided or cached authorization server URL is rejected when its `issuer` does not match that URL, and the public
`discoverAuthorizationServerMetadata()` helper throws on mismatches or invalid issuer identifiers. For legacy servers without protected resource metadata, metadata is still discovered at the MCP server origin; when that metadata names a distinct issuer, the SDK now treats the
metadata `issuer` as the authorization server URL for persisted discovery state and fallback endpoint construction.
