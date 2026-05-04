---
'@modelcontextprotocol/server': minor
---

Add ToolError class for secure-by-default tool error handling. Unhandled errors from tool handlers are now sanitized to "Internal error" instead of exposing raw messages. Use `throw new ToolError('message')` when you want clients to see a specific error message.
