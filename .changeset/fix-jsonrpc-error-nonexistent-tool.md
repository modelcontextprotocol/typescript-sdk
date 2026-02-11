---
"@modelcontextprotocol/sdk": patch
---

fix: return JSON-RPC error for nonexistent tool calls

When `callTool` is invoked with a tool name that doesn't exist in the registered handlers, the server now returns a proper JSON-RPC error with code -32601 (Method not found) instead of returning an error in the content array. This aligns with JSON-RPC 2.0 specification and provides clearer error handling for clients.
