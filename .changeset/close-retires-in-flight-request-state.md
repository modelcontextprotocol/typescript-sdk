---
'@modelcontextprotocol/server': patch
---

Fix `WebStandardStreamableHTTPServerTransport.close()` leaving in-flight request state behind.

`close()` cleared `_streamMapping` and `_requestResponseMap` but never cleared
`_requestToStreamMapping`, so request ids stayed resolvable after the transport was
closed. A `send()` suspended in `eventStore.storeEvent()` across a `close()` resumed
against the retired correlation and recorded a response that could never be delivered,
leaking both the response and its correlation for the lifetime of the process. `close()`
now retires the correlations, and `send()` re-checks the correlation after the
`storeEvent()` await — the same reason the stream is already re-read there.

`close()` also now settles JSON-response-mode POSTs that are parked waiting for their
responses, answering `404 Session not found` instead of leaving the HTTP request hanging
until the platform's own timeout fires.

Both paths also apply to `NodeStreamableHTTPServerTransport`, which wraps this transport.
