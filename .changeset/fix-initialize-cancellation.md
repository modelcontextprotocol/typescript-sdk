---
'@modelcontextprotocol/core': patch
---

Do not send `notifications/cancelled` for `initialize` requests. Per the MCP specification, clients must not cancel the `initialize` request; when the caller aborts or times out during `connect()`, the promise still rejects locally but the wire notification is no longer emitted.
