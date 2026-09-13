---
'@modelcontextprotocol/client': patch
---

`StreamableHTTPClientTransport` now re-sends the `Last-Event-ID` header when a resumed SSE stream disconnects before any id-bearing event arrives (LB idle timeout, server restart). Previously the reconnect GET was sent without the header, so the server treated it as a brand-new stream and never replayed the missed events, hanging long-running requests. Fixes #2499
