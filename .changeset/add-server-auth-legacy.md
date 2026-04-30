---
'@modelcontextprotocol/server-auth-legacy': patch
---

Add `@modelcontextprotocol/server-auth-legacy`, a deprecated, frozen copy of the v1 SDK's `src/server/auth/` Authorization Server helpers (`mcpAuthRouter`, `ProxyOAuthServerProvider`, OAuth handlers/middleware/errors). Provided solely for v1 → v2 migration; new code should use a dedicated IdP plus the Resource Server helpers in `@modelcontextprotocol/express`.
