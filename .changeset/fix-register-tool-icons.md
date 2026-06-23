---
'@modelcontextprotocol/server': patch
---

Support `icons` in `McpServer.registerTool()` config and include it in `tools/list` responses. The MCP spec's `ToolSchema` includes `icons` via `IconsSchema`, but the high-level API did not accept or serialize it.
