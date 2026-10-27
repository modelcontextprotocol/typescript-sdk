---
'@modelcontextprotocol/core-internal': minor
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server': minor
---

Add a `logger` option to `Client`, `McpServer` and `createMcpHandler` so their SDK diagnostics can be routed through user-provided logging. Omitting it keeps the current `console` output. The OAuth helpers (`auth()` and the built-in providers) still write to `console.warn`.
