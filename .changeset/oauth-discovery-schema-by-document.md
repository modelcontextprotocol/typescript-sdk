---
'@modelcontextprotocol/core': patch
'@modelcontextprotocol/client': patch
---

OAuth discovery now validates authorization server metadata by its document shape instead of by the well-known path it was found under: RFC 8414 metadata served at the `openid-configuration` path (permitted by RFC 8414 §5) is accepted, a document that fits neither schema skips to the next candidate URL instead of aborting discovery, and `OpenIdProviderDiscoveryMetadataSchema` is now a loose object so mixed OIDC/OAuth documents keep their RFC 8414 fields (e.g. `revocation_endpoint`, `introspection_endpoint`).
