---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Stop sending `notifications/cancelled` for the `initialize` handshake. The spec is explicit that a client MUST NOT attempt to cancel its `initialize` request, but the outbound cancel path fired for any in-flight request: aborting the `AbortSignal` passed to `connect()`, or letting the handshake hit its timeout, put a forbidden cancellation on the wire naming the initialize request id.

The local behaviour is unchanged — the caller's promise still rejects with the same abort/timeout error, and `connect()` still tears the connection down. Only the wire notification is suppressed. Every other method keeps the existing cancellation path.
