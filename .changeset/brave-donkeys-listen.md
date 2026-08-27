---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/client': patch
---

`SdkError` now accepts standard `ErrorOptions`, and version-negotiation probe failures surface the underlying network error via `Error.cause` (#2657).
