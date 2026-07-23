---
'@modelcontextprotocol/server': minor
'@modelcontextprotocol/express': patch
---

Add runtime-neutral OAuth discovery serving to `@modelcontextprotocol/server`:
`oauthMetadataResponse` serves the RFC 9728 Protected Resource Metadata and
RFC 8414 Authorization Server metadata documents from web-standard
`fetch(request)` hosts, built on the exported
`buildOAuthProtectedResourceMetadata`, with
`getOAuthProtectedResourceMetadataUrl` now defined here. The Express metadata
router adapts the same core and is unchanged in behavior; the insecure-issuer
escape hatch is an explicit `dangerouslyAllowInsecureIssuerUrl` option in the
neutral core instead of a module-scope environment read. The web-standard
matcher validates lazily so unmatched traffic always falls through, tolerates
a trailing slash, supports HEAD, and marks reflected CORS preflights with
`Vary`.
