---
'@modelcontextprotocol/sdk': patch
---

`StreamableHTTPClientTransport` keeps the resumption cursor a stream was opened with. When a stream resumed with a resumption token disconnects before any event carrying an id arrives, the reconnect now sends the same `Last-Event-ID` instead of omitting it, so the server resumes
the stream rather than treating it as a new one and the events sent in the meantime are still replayed.
