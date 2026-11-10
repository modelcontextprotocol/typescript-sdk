---
'@modelcontextprotocol/server': patch
---

Reject sampling histories containing assistant `tool_use` blocks without matching `tool_result` blocks in the immediately following user message. Also reject `tool_use` blocks in user messages and `tool_result` blocks in assistant messages.
