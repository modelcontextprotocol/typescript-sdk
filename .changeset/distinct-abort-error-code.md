---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/client': patch
---

Cancelling a request via `AbortSignal` (`controller.abort()`) now rejects with the new `SdkErrorCode.RequestAborted`, distinct from `SdkErrorCode.RequestTimeout`. Previously both a deliberate abort and the request's own timeout elapsing surfaced as `RequestTimeout`, so callers could not tell them apart (`Protocol.request()`, the response-cache warm-hit path, and `Client.listen()` all shared the same fallback). The request's own timeout still reports `RequestTimeout` unchanged.
