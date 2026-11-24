---
'@modelcontextprotocol/client': patch
---

Close the underlying `EventSource` when `SSEClientTransport.start()` rejects so a failed initial connection no longer schedules background reconnect timers.
