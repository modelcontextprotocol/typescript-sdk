---
"@modelcontextprotocol/core": patch
"@modelcontextprotocol/server": patch
"@modelcontextprotocol/client": patch
---

Allow async `onclose` callbacks on Transport and Protocol. The signature changes from `() => void` to `() => void | Promise<void>`, and all call sites now await the callback. This lets MCP servers perform async cleanup (e.g., releasing browser sessions or database connections) when the transport closes.

Close `StdioServerTransport` when stdin reaches EOF, so containerized servers exit cleanly on client disconnect.

Add SIGTERM handlers alongside SIGINT in all examples, since MCP servers run as background processes stopped by SIGTERM, not interactively via Ctrl+C.
