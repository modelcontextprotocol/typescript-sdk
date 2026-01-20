---
"@modelcontextprotocol/core": minor
"@modelcontextprotocol/server": minor
---

BREAKING: Fix error handling for unknown tools and resources per MCP spec

**Tools:** Unknown or disabled tool calls now return JSON-RPC protocol errors with
code `-32602` (InvalidParams) instead of `CallToolResult` with `isError: true`.
Users who checked `result.isError` for unknown tools should catch rejected promises instead.

**Resources:** Unknown resource reads now return error code `-32002` (ResourceNotFound)
instead of `-32602` (InvalidParams), per the MCP specification.

Added `ErrorCode.ResourceNotFound` to the ErrorCode enum.
