---
'@modelcontextprotocol/server': minor
'@modelcontextprotocol/express': patch
---

Lift the framework-agnostic OAuth Resource-Server helpers from `@modelcontextprotocol/express` to `@modelcontextprotocol/server`: `OAuthTokenVerifier`, `buildWwwAuthenticateHeader`, `checkIssuerUrl`, `getOAuthProtectedResourceMetadataUrl`, and a new `buildProtectedResourceMetadata`/`ProtectedResourceMetadataOptions`. `/express` re-exports them for backwards compatibility and now consumes them from `/server`, so other adapter packages (`/hono`, `/fastify`) can ship thin RS-auth middleware without duplicating the RFC 6750/9728 logic.
