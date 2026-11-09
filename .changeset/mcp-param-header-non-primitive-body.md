---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/server': patch
---

Reject a `tools/call` with `400` / `-32020` (`HeaderMismatch`) when an `Mcp-Param-*` header is present but the matching body argument is an object or array. Previously the header check was skipped and the call was answered `200` with a tool input-validation error.
