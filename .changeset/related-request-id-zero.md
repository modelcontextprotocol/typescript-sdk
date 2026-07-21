---
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
'@modelcontextprotocol/server-legacy': patch
---

Treat numeric related request ID `0` as present when deciding whether to debounce notifications. Request-associated notifications for the first request ID are no longer coalesced, and send failures now reject the notification promise consistently with other request IDs.
