---
'@modelcontextprotocol/client': minor
---

Apply resolved scope consistently to both DCR and the authorization URL (SEP-835)

When `scopes_supported` is present in the protected resource metadata (`/.well-known/oauth-protected-resource`), the SDK already uses it as the default scope for the authorization URL. This change applies the same resolved scope to the dynamic client registration request body, ensuring both use a consistent value.

- `registerClient()` now accepts an optional `scope` parameter that overrides `clientMetadata.scope` in the registration body.
- `auth()` now computes the resolved scope once (WWW-Authenticate → PRM `scopes_supported` → `clientMetadata.scope`) and passes it to both DCR and the authorization request.
