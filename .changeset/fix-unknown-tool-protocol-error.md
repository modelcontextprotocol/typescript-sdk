---
"@modelcontextprotocol/core": minor
"@modelcontextprotocol/server": major
---

Fix error handling for unknown tools and resources per MCP spec.

**Tools:** Unknown or disabled tool calls now return JSON-RPC protocol errors with
code `-32602` (InvalidParams) instead of `CallToolResult` with `isError: true`.
Callers who checked `result.isError` for unknown tools should catch rejected promises instead.

**Resources:** Added `ProtocolErrorCode.ResourceNotFound` (`-32002`) as receive-tolerated
vocabulary. The wire code emitted for an unknown `resources/read` URI is `-32602`
(Invalid Params) — see the `resource-not-found-32602` changeset.
