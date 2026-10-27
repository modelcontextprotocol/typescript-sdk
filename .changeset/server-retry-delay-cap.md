---
'@modelcontextprotocol/client': patch
---

Cap the server-provided SSE retry delay at `maxReconnectionDelay` and clear it when a new stream is established, so a large or malicious `retry:` value cannot stall reconnects for days.
