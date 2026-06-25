---
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/core-internal': minor
---

Add the public surface for the 2026-07-28 authorization requirements. New `AuthOptions` type names the `auth()` options object and adds `iss` and `skipIssuerMetadataValidation` fields. `OAuthClientProvider.clientInformation()` / `.saveClientInformation()` / `.tokens()` / `.saveTokens()` accept an optional `OAuthClientInformationContext` carrying the authorization server's `issuer` so providers can key persisted credentials per authorization server. New `StoredOAuthTokens` / `StoredOAuthClientInformation` aliases add an `issuer` stamp field on top of the wire types (kept off the wire schemas so an authorization server cannot populate it) and become the parameter/return types of the credential methods. New `OAuthClientFlowError` base class in `authErrors.ts` for the flow-specific error classes that follow. All changes are additive — existing `OAuthClientProvider` implementations compile unchanged; the new fields are inert until the behavior changes that follow wire them up.
