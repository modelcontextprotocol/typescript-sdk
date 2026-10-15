---
'@modelcontextprotocol/server': patch
---

Settle pending JSON-response-mode requests when the streamable HTTP transport
closes, instead of leaving the HTTP request hanging.

In JSON response mode, `handleRequest()` returns a `Promise<Response>` that only
`send()` resolves. A stream mapping's `cleanup` deletes the entry without
settling that promise, so `WebStandardStreamableHTTPServerTransport.close()`
while a POST was in flight left the HTTP request open until the socket died —
and the caller unable to tell whether the request ran, which for a mutating call
means retrying may double-execute and giving up may drop a completed write.

`close()` now resolves any such pending response before the stream mappings are
torn down, with a JSON-RPC error (`-32000`, `"Connection closed"`) for each
request id still outstanding. A batched POST shares one stream across several
request ids, so the outstanding ids are grouped by stream, and an id that
already has a real response reuses it rather than being overwritten with an
error.

The SSE path is deliberately unchanged: a POST-initiated SSE stream closing
without a JSON-RPC response is the documented outcome of session termination
(`hosting:session:delete-cancels-inflight`), where the request handler has been
aborted and the request is therefore cancelled rather than unanswered.

`close()` also clears `_requestToStreamMapping`, which it previously left
populated.

`NodeStreamableHTTPServerTransport` wraps this transport, so it inherits the
fix.
