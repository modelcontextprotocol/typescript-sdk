---
'@modelcontextprotocol/core': major
'@modelcontextprotocol/server': major
'@modelcontextprotocol/client': major
---

2026-06 stateless protocol support (SEP-2575, SEP-2567, SEP-2322).

`Server` and `Client` now support the 2026-06 stateless connection model
alongside the existing pre-2026 model. They remain the same classes (still
extending `Protocol`); the new behavior is additive.

- `Client.connect()` auto-probes `server/discover` and falls back to the
  legacy `initialize` handshake.
- `Server` gained `subscriptions` and `statelessHandlers()`; transports route
  per-message via the `MCP-Protocol-Version` header / `_meta` key.
- `handleHttp(server, opts)` is a new Fetch-API entry point: one shared
  `Server` instance, no `Transport`, no `connect()`.
- `client.subscribe(filter)` opens a `subscriptions/listen` stream.
- `Transport` interface gained optional `setStatelessHandlers?` and
  `sendAndReceive?` for custom transports.
- Prefer `ctx.mcpReq.{elicitInput, requestSampling, listRoots, log}` inside
  handlers; works under both protocols (MRTR under 2026-06).

See `docs/migration.md` for the full guide.
