---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/server': patch
---

Reject a `tools/call` with `400` / `-32020` (`HeaderMismatch`) when a body argument declared with `x-mcp-header` is an object or array, with or without its `Mcp-Param-*` header, and when the argument is an integer outside the safe range but the header is present. Previously the header check was skipped for these values, so the call reached the tool.
