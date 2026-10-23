---
'@modelcontextprotocol/server': patch
---

Fix a rejected event-store write leaking the request stream in
`WebStandardStreamableHTTPServerTransport`.

`send()` awaits the user-supplied `eventStore.storeEvent()` before writing a response to
the per-request SSE stream. A rejection propagated straight out of `send()`, skipping
every teardown below it: the stream mapping and the request correlation stayed in their
maps, the keep-alive timer stayed armed, and the HTTP response body was never closed — so
the client waited on a stream that would never carry its response, and the server held the
request forever.

The write is now wrapped so a rejection retires the request and closes its stream before
the error is rethrown. `send()` still rejects, so callers continue to see the failure.

Also applies to `NodeStreamableHTTPServerTransport`, which wraps this transport.
