---
'@modelcontextprotocol/sdk': patch
---

Reject duplicate in-flight request ids in the Streamable HTTP server transport instead of cross-wiring responses. A second POST that reused a JSON-RPC id still in flight previously overwrote the `_requestToStreamMapping` entry, routing the original request's response onto the new
stream and leaving the first POST hanging; such requests, and ids duplicated within a single batch, are now rejected with HTTP 400 and JSON-RPC -32600. Transport bookkeeping for cancelled requests is retired on `notifications/cancelled` so their ids stay reusable, and a
`isCancelledNotification` guard is added.
