---
'@modelcontextprotocol/server': patch
---

Validate low-level `Server` tool calls against the `inputSchema` advertised by `tools/list` before dispatching them. Invalid arguments now return an `isError` tool result instead of reaching the handler.
