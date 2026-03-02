---
'@modelcontextprotocol/server': patch
---

Close StdioServerTransport when stdin reaches EOF. The MCP spec requires the client to close stdin as the first step of stdio shutdown, but the server transport never listened for the `end` event, leaving it in a zombie state until SIGTERM escalation. Also adds an idempotency guard to `close()` to prevent double `onclose` invocation.
