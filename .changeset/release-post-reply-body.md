---
'@modelcontextprotocol/client': patch
---

`StreamableHTTPClientTransport.send()` and `SSEClientTransport.send()` no longer wait for the end of a POST reply with a 2xx status whose body they do not read (a `202`, a reply to a message with no requests, a reply with an unexpected content type). A server or proxy that sends the headers of such a reply and keeps it open no longer stalls `send()` or `Client.connect()`. The unread body is still read to its end, but `send()` does not wait for that; a body that has not ended after 100 ms is cancelled, which closes its HTTP/1.1 connection unless a custom `fetch` holds a clone of the reply. A body with no `getReader()`, as a custom `fetch` may return, is read in the same way but never cancelled. POST replies with any other status and `terminateSession()` still wait for the end of the body.
