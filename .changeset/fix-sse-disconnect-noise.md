---
'@modelcontextprotocol/client': patch
---

Suppress `onerror` when an SSE stream disconnects but reconnection will be scheduled. Previously `onerror` fired unconditionally on every stream disconnect, producing `"SSE stream disconnected: TypeError: terminated"` noise every few minutes on long-lived connections even though the transport recovered transparently.
