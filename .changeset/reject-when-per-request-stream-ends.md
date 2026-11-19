---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Reject in-flight outbound JSON-RPC on modern Streamable HTTP when the per-request SSE stream ends without a response, using `ConnectionClosed` instead of waiting until the read timeout. Wire `TransportSendOptions.onRequestStreamEnd` through `Protocol`, and forward it on the client transport's explicit resumption GET path when `send()` is called with a saved `resumptionToken`.