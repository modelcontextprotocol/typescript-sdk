---
'@modelcontextprotocol/sdk': patch
---

`OpenIdProviderDiscoveryMetadataSchema` no longer drops the OAuth 2.0 fields that OpenID discovery documents carry. Spreading `OpenIdProviderMetadataSchema.shape` into a plain `z.object` discarded its loose behaviour, so `revocation_endpoint` (and every other undeclared field)
was stripped from the parsed metadata before it reached the client's provider. A client that reads `authorizationServerMetadata.revocation_endpoint` to revoke tokens saw `undefined` from an authorization server that publishes only OpenID discovery, and concluded revocation was
unsupported. The schema is a `z.looseObject` again, and `revocation_endpoint`, `revocation_endpoint_auth_methods_supported` and `revocation_endpoint_auth_signing_alg_values_supported` are declared so they arrive typed.
