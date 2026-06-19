---
'@modelcontextprotocol/server': minor
---

SEP-2243 `Mcp-Param-*` server-side validation (protocol revision 2026-07-28). On the modern (2026-07-28) serving path, `createMcpHandler` now validates `Mcp-Param-{Name}` headers against the named tool's `x-mcp-header` declarations and the body `arguments` before dispatch: a missing header for a present body value, a header that decodes to a different value than the body, or an invalid `=?base64?…?=` sentinel is rejected with `400 Bad Request` and JSON-RPC `-32001` (`HeaderMismatch`) — the same shape the existing standard-header cross-checks emit. A `null`/absent body value passes regardless of any header (the spec's "server MUST NOT expect the header" rows). `McpServer.registerTool` now warns at registration time when an `x-mcp-header` declaration violates the spec's constraints. The 2025-era serving paths and the low-level `Server` factory shape are unchanged.
