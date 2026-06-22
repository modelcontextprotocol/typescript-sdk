---
'@modelcontextprotocol/core': minor
'@modelcontextprotocol/server': minor
---

SEP-2243 standard-header server-side validation (protocol revision 2026-07-28). On the modern (2026-07-28) serving path, `createMcpHandler` now enforces the required `Mcp-Method` and `Mcp-Name` standard request headers in addition to the existing `MCP-Protocol-Version` and `Mcp-Method` cross-checks: a modern request without an `Mcp-Method` header, a `tools/call` / `prompts/get` / `resources/read` request without an `Mcp-Name` header, an `Mcp-Name` header carrying an invalid `=?base64?…?=` sentinel, and an `Mcp-Name` header whose (decoded) value disagrees with the body's `params.name` / `params.uri` are all rejected with `400 Bad Request` and JSON-RPC `-32001` (`HeaderMismatch`). The 2025-era serving paths are unchanged.

New public surface:

- `@modelcontextprotocol/core`: `validateStandardRequestHeaders` (function), `MCP_NAME_HEADER_SOURCE` (const), the `mcpNameHeader` field on `InboundHttpRequest`, and the `'standard-header-validation'` member of `InboundValidationRung` (with `client-capabilities` / `param-header-validation` renumbered).
