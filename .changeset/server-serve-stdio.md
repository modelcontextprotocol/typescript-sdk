---
'@modelcontextprotocol/server': minor
---

Add `serveStdio(factory, options?)` (exported from `@modelcontextprotocol/server/stdio`), the connection-pinned stdio entry point for serving the 2026-07-28 draft revision on long-lived connections. The entry owns the transport and the era decision: the client's opening
exchange selects the era (a 2025 `initialize` handshake, 2026-07-28 per-request `_meta` envelope traffic, or a `server/discover` probe followed by either), and ONE instance from the factory is pinned to the connection and serves only that era — mirroring how
`createMcpHandler` classifies each HTTP request before constructing an instance. 2025-era openings are served by default; `legacy: 'reject'` answers them with the unsupported-protocol-version error naming the supported modern revisions instead. A `transport` option
accepts a bring-your-own `StdioServerTransport` (for example over a Unix domain socket); `onerror` reports out-of-band errors; the returned handle's `close()` tears the connection down.

Removed: `ServerOptions.eraSupport` (introduced in an earlier 2.0 alpha, never in a stable release). A hand-constructed `Server`/`McpServer` serves only the 2025-era protocol it was written for; serving the 2026-07-28 revision always goes through a serving entry. Migrate
`new McpServer(info, { eraSupport: 'dual-era' })` + `connect(new StdioServerTransport())` to `serveStdio(() => new McpServer(info))`, and `eraSupport: 'modern'` to `serveStdio(factory, { legacy: 'reject' })`.
