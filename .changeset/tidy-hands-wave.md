---
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/core-internal': patch
---

Bound the legacy `Client.connect()` handshake's `notifications/initialized` POST by a separate per-stage timeout (the configured `timeout`, or the default request timeout), rather than a shared total connection budget. Only caller cancellation during the `notifications/initialized` stage rejects with the original abort reason and aborts the POST. The `initialize` stage retains `request()` behavior: non-`SdkError` abort reasons are wrapped in an `SdkError` with code `RequestTimeout`.
