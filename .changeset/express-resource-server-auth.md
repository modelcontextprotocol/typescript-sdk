---
'@modelcontextprotocol/express': minor
---

Add OAuth Resource-Server glue to the Express adapter: `requireBearerAuth` middleware (token verification + RFC 6750 `WWW-Authenticate` challenges), `mcpAuthMetadataRouter` (serves RFC 9728 Protected Resource Metadata and mirrors RFC 8414 AS metadata at the resource origin), the `getOAuthProtectedResourceMetadataUrl` helper, and the `OAuthTokenVerifier` interface. These restore the v1 `src/server/auth` Resource-Server pieces as first-class v2 API so MCP servers can plug into an external Authorization Server with a few lines of Express wiring.
