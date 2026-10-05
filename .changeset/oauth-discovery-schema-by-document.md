---
'@modelcontextprotocol/core': patch
'@modelcontextprotocol/client': patch
---

OAuth discovery now validates authorization server metadata by its document shape instead of by the well-known path it was found under: RFC 8414 metadata served at the `openid-configuration` path (permitted by RFC 8414 §5) is accepted; an invalid value in an optional field drops that field instead of failing the document; a document that fits neither schema skips to the next candidate URL, and if every candidate fails validation, discovery throws an error naming the schema issues instead of silently falling back to guessed endpoints. `OpenIdProviderDiscoveryMetadataSchema` is now a loose object that declares the RFC 8414 revocation/introspection fields with their OAuth validators, so mixed OIDC/OAuth documents keep those fields validated rather than stripped, and `introspection_endpoint` is validated as a safe URL like `revocation_endpoint`.
