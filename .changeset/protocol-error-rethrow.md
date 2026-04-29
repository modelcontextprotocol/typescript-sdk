---
'@modelcontextprotocol/server': minor
---

Re-throw all `ProtocolError` instances from `tools/call` handler as JSON-RPC errors instead of wrapping them in `isError: true` results.

**Breaking change:** Output validation failures (missing or schema-mismatched `structuredContent`) now surface as JSON-RPC `InternalError` rejections instead of `{ isError: true }` results. Input validation failures continue to return `{ isError: true }` per the MCP spec's tool-execution-error classification.

This also means tool handlers that deliberately `throw new ProtocolError(...)` will now propagate that as a JSON-RPC error, matching the python-sdk behavior.
