---
'@modelcontextprotocol/client': patch
---

`listTools()`, `listPrompts()`, `listResources()` and `listResourceTemplates()` called without a cursor now keep `nextCursor` on the result when the walk stopped early because the server repeated a cursor, so an incomplete list can be told apart from a complete one; a complete list still has no `nextCursor`.
