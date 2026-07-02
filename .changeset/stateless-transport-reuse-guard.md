---
'@modelcontextprotocol/server': patch
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/client': patch
---

Restores two v1 transport lifecycle invariants dropped in the v2 rewrite:

- A stateless `WebStandardStreamableHTTPServerTransport` (`sessionIdGenerator: undefined`) handles a single request exchange and throws on reuse (matching v1 behavior since 1.26.0): `"Stateless transport cannot be reused across requests. Create a new transport per request."` Construct a fresh transport (and server instance) per request, or use `createMcpHandler`, which already serves per-request pairs. Stateful transports (`sessionIdGenerator` set) are unaffected; `NodeStreamableHTTPServerTransport` inherits the behavior.
- `Protocol.connect()` (and `Client.connect()`) throw when the instance is already connected, instead of silently rebinding the transport: `"Already connected to a transport. Call close() before connecting to a new transport, or use a separate Protocol instance per connection."` Sequential `close()` then `connect()` keeps working. After `close()` aborts an in-flight request handler, `ctx.mcpReq.notify()` resolves as a no-op and `ctx.mcpReq.send()` rejects with `SdkError(ConnectionClosed)`, consistent with the above.

Docs, middleware READMEs, and examples that showed a shared stateless transport now show the per-request pattern.
