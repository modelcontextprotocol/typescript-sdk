---
'@modelcontextprotocol/server': patch
---

Fix `sendToolListChanged()`/`sendResourceListChanged()`/`sendPromptListChanged()` silently dropping their notification on a stateless Streamable HTTP transport when called from inside a request handler. These methods send with no `relatedRequestId`, so the transport routed them at the standalone GET SSE stream — which stateless transports never open, so the message had nowhere to go. Notifications sent while a handler is in flight are now automatically tagged with that handler's request id (unless the caller supplied its own `relatedRequestId`), so they ride the request's own response stream instead.
