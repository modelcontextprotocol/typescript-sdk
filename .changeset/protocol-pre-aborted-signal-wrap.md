---
'@modelcontextprotocol/core-internal': patch
---

`Protocol.request()` now rejects with `SdkError(RequestTimeout, reason)` when called with an already-aborted signal, matching in-flight aborts. Previously the raw `signal.reason` was thrown.
