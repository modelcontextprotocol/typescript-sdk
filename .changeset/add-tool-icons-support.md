---
'@modelcontextprotocol/server': patch
---

Added `icons` field support to `registerTool()` and `registerToolTask()` APIs, matching the `ToolSchema` spec definition. Icons are now included in `tools/list` responses and can be updated via `tool.update()`.
