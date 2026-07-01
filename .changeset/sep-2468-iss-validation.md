---
'@modelcontextprotocol/client': minor
---

Refine RFC 9207 `iss` parameter validation for authorization responses (SEP-2468). `validateAuthorizationResponseIssuer()` gains a two-argument `(metadata, iss)` overload, and `auth()`'s `iss` option plus `StreamableHTTPClientTransport.finishAuth()` / `SSEClientTransport.finishAuth()` second arguments now use tri-state `string | null | undefined` semantics, with `finishAuth()` also accepting an `{ iss }` options object. The `iss` option is tri-state: a string is validated by exact comparison against the issuer recorded in the
authorization server metadata before the authorization code is sent to any token endpoint (mismatch rejects the response without processing any other response parameters); `null` asserts the caller inspected the authorization response and it carried no `iss`, enabling the RFC
9207 fail-closed rejection when the AS advertises `authorization_response_iss_parameter_supported: true`; `undefined` (omitted) skips RFC 9207 response validation, so existing `finishAuth(code)` callers that never see the authorization response are unaffected.

Discovery also now validates authorization-server metadata issuer values per RFC 8414 Section 3.3. Metadata discovered for a PRM-provided authorization server URL is rejected when its `issuer` does not match that URL, and the public `discoverAuthorizationServerMetadata()` helper
throws on mismatches or invalid issuer identifiers unless called with `{ validateIssuer: false }` for intentional alias discovery. Cached discovery state is also validated; stale legacy no-PRM fallback state that saved the MCP server origin before learning a distinct metadata
issuer is ignored and refreshed. For legacy servers without protected resource metadata, metadata is still discovered at the MCP server origin; when that metadata names a distinct issuer, the SDK now treats the metadata `issuer` as the authorization server URL for persisted
discovery state and fallback endpoint construction.

Cross-App Access IdP discovery (`discoverAndRequestJwtAuthGrant()` / `CrossAppAccessProvider`) intentionally skips the RFC 8414 issuer-echo check, so configured IdP alias URLs whose metadata names a canonical issuer keep working.
