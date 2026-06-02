---
"@modelcontextprotocol/server": patch
---

Exit server process when MCP client closes stdin pipe. Previously, `StdioServerTransport` failed to detect when a client closed its stdin pipe, causing server processes to accumulate as zombies. This adds `close` and `end` event listeners on stdin that trigger proper transport cleanup.
