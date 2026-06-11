---
'@modelcontextprotocol/client': patch
---

Fix `adaptOAuthProvider` returning expired tokens on long-running StreamableHTTP connections. The adapter now intercepts `saveTokens` to record when each token was issued, then checks elapsed time against `expires_in` (with a 60-second buffer) before returning the token. Expired or near-expiry tokens return `undefined`, causing the transport to omit the `Authorization` header and trigger a 401 → `onUnauthorized` → refresh flow.
