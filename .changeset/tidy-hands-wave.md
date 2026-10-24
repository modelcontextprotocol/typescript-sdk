---
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/core-internal': patch
---

Bound the legacy `Client.connect()` handshake's `notifications/initialized` POST by a separate per-stage timeout (the configured `timeout`, or the default request timeout), rather than a shared total connection budget. Caller cancellation during this stage rejects with the original abort reason and aborts the POST.
