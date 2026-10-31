---
'@modelcontextprotocol/client': patch
---

`SSEClientTransport` now closes, firing `onclose` and rejecting pending requests with `ConnectionClosed`, when its SSE stream drops after connecting and the reconnect fails for good, for example with a 404 after the server restarts. Previously the transport stayed open with no stream, so pending requests waited for their timeout and the application was never told the connection had ended.
