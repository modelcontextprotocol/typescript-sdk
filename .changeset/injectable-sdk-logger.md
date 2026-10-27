---
'@modelcontextprotocol/core-internal': minor
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server': minor
---

Add a `logger` option to `Client`, `McpServer`, `createMcpHandler` and `OAuthClientProvider` (including the built-in providers such as `ClientCredentialsProvider`) so SDK diagnostics can be routed through user-provided logging. Omitting it keeps the current `console` output.
