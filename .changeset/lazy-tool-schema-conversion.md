---
'@modelcontextprotocol/server': patch
---

`registerTool` no longer converts tool schemas up front, so a server built per request stops converting every tool on every request. The warning about an invalid `x-mcp-header` declaration now appears each time tools are listed, not when the tool is registered.
