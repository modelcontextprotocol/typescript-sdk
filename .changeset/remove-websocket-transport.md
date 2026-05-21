---
'@modelcontextprotocol/client': major
---

Remove `WebSocketClientTransport`. WebSocket is not a spec-defined transport; use stdio or Streamable HTTP. The `Transport` interface remains exported for custom implementations. See #142.
