---
'@modelcontextprotocol/server': patch
---

Close `StdioServerTransport` when server stdin closes so stdio MCP servers do not remain alive after their client disconnects.
