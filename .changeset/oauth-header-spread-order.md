---
'@modelcontextprotocol/client': patch
---

Fix the spread order in `StreamableHTTPClientTransport._commonHeaders()` and `SSEClientTransport._commonHeaders()` so SDK-derived common headers (including fresh OAuth tokens from `authProvider`) win over caller-supplied headers in `requestInit.headers`. Previously a caller-supplied `Authorization` placeholder (e.g. an env-var API key) was merged after the SDK-computed value, silently overriding OAuth-refreshed tokens and breaking the auth-refresh flow once the placeholder went stale. Closes #2208.
