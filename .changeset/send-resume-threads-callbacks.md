---
'@modelcontextprotocol/client': patch
---

`StreamableHTTPClientTransport.send()` no longer drops `onresumptiontoken` and `onRequestStreamEnd` when called with a `resumptionToken`. The resume branch opened the GET with the correct `Last-Event-ID` but passed neither callback to the reopened stream, so a caller resuming a long-running request stopped receiving newer resumption tokens — its persisted token went permanently stale, and a later resume replayed already-delivered events or fell outside the server event store's retention window — and was never notified when the stream ended non-resumably. Both callbacks are now threaded through, matching the original POST path and `resumeStream()`.
