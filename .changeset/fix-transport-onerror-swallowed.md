---
'@modelcontextprotocol/server': patch
---

Call `onerror` callback for transport errors that were previously silently swallowed. Nested try/catch blocks in `handlePostRequest` for JSON parsing and JSON-RPC validation now invoke `onerror` before returning error responses. The `writeSSEEvent` method also reports errors via `onerror` instead of silently returning `false`.
