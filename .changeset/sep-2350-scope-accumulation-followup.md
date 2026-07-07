---
'@modelcontextprotocol/client': patch
---

Preserve previously requested OAuth scopes across Streamable HTTP, legacy SSE, automatic 401 handling, scope step-up, and `withOAuth`. Step-up unions explicit token, transport, and challenged scopes; when prior scope is unavailable, it reconstructs the initial protected-resource-metadata/provider fallback without over-requesting both.
