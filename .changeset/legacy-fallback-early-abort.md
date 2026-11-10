---
'@modelcontextprotocol/server': patch
---

The stateless legacy fallback of `createMcpHandler` now answers `499` with no body, closes the per-request transport and server, and runs nothing when the client aborted the request while the factory or `connect()` was still running. Before, that abort was never seen: the request ran to completion and `ctx.mcpReq.signal` never aborted. The modern path already answered `499` in this case.
