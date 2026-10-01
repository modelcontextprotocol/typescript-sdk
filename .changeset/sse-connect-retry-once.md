---
'@modelcontextprotocol/client': patch
---

`SSEClientTransport` now retries the SSE connection once after `onUnauthorized()` resolves, as documented. If the retry is also answered with 401, `start()` rejects with `SdkHttpError` (`ClientHttpAuthentication`) instead of calling `onUnauthorized()` again. A 401 on a later reconnect of a stream that had opened still gets one refresh.
