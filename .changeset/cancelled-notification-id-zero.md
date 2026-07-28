---
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Handle `notifications/cancelled` for request ID `0`. JSON-RPC allows `0` as a valid request ID, but the cancellation handler used a truthiness check and silently dropped cancellations for requests numbered `0`; the handler now checks for `undefined` explicitly, so those requests are cancelled correctly.
