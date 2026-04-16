---
'@modelcontextprotocol/server': patch
---

Restore `McpServer.tool()`, `.prompt()`, `.resource()` variadic overloads as `@deprecated` v1-compat shims forwarding to `registerTool`/`registerPrompt`/`registerResource`.
