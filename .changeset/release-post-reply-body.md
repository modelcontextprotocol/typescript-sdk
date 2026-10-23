---
'@modelcontextprotocol/client': patch
---

`StreamableHTTPClientTransport.send()` and `SSEClientTransport.send()` no longer wait for the end of a successful POST reply whose body they do not read (a `202`, a reply to a message with no requests, a reply with an unexpected content type). A server or proxy that sends the headers and keeps the response open no longer stalls `send()` or `Client.connect()`. The unread body is now cancelled without waiting, instead of being read to its end; when part of it has not arrived yet, the connection is closed instead of reused. A body with no `cancel()`, as a custom `fetch` may return, is still read, but no longer waited for.
