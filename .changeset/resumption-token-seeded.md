---
'@modelcontextprotocol/client': patch
---

`StreamableHTTPClientTransport` keeps the resumption cursor it was opened with. When a stream resumed with a resumption token disconnects before any event carrying an id arrives, the reconnect now sends the same `Last-Event-ID` instead of omitting it, so the server resumes the stream instead of treating it as a new one and the events sent in the meantime are still replayed.
