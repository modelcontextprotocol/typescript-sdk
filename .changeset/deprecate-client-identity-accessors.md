---
'@modelcontextprotocol/server': patch
---

Deprecate `Server.getClientCapabilities()`, `Server.getClientVersion()` and `Server.getNegotiatedProtocolVersion()` in favor of the per-request handler context: on 2026-07-28 requests the validated `_meta` envelope carries the client's identity (`ctx.mcpReq.envelope`),
and instances serving that revision through `createMcpHandler` are backfilled per request so the accessors keep answering. Behavior on 2025-era connections is unchanged; the accessors remain functional.
