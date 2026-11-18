---
'@modelcontextprotocol/core-internal': minor
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server': minor
---

Add a `logger` option to `Client`, `McpServer`, `createMcpHandler` and the built-in OAuth providers such as `ClientCredentialsProvider`, and an optional `sdkLogger` property to `OAuthClientProvider`, so SDK diagnostics can be routed through user-provided logging. Omitting them keeps the current `console` output.
