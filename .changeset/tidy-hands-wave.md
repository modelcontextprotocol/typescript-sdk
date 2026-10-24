---
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/core-internal': patch
---

Bound the legacy `Client.connect()` handshake's `notifications/initialized` POST by its timeout and abort signal.
