---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/server': patch
---

Reject unsafe integers in annotated `x-mcp-header` tool parameters when the mirrored header is absent: Streamable HTTP specification dictates that integer values must be within the JavaScript safe-integer range (−2^53+1 to 2^53−1). Previously, `validateMcpParamHeaders` skipped parity validation when a parameter value could not be represented as a canonical primitive string (`mcpParamPrimitiveToString` returning `undefined`), allowing unsafe integer arguments (such as `9007199254740992`) to bypass header validation and invoke handlers without the required `Mcp-Param-*` header. `validateMcpParamHeaders` now validates missing headers for all primitive values, disallows unsafe integers from numeric coercion, and returns `400 Bad Request` / `-32020 HeaderMismatch` before handler invocation.
