---
'@modelcontextprotocol/server': patch
---

Stop reporting server-internal POST failures as client parse errors in
`WebStandardStreamableHTTPServerTransport`.

`handleRequest()` re-checks `_closed` and answers `404 Session not found`, but
`writePrimingEvent()` awaits the user-supplied event store _after_ those checks. A
`close()` landing during that write left the priming event enqueueing onto an
already-closed controller, and the resulting `Invalid state` error fell into the POST
handler's catch-all — which answered `400 Parse error (-32700)`. The client was told to
fix a request body that was never the problem.

`writePrimingEvent()` now returns early if the transport closed during the store write,
the POST handler answers `404 Session not found` at that suspension point like it does at
the two before it, and the catch-all maps to `500 Internal error (-32603)`. Genuine parse
failures are unaffected: invalid JSON and invalid JSON-RPC messages are still answered
`400 -32700` by the dedicated guards that precede it.

Also applies to `NodeStreamableHTTPServerTransport`, which wraps this transport.
