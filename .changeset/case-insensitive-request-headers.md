---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/client': patch
---

`createFetchWithInit()` now applies per-request header overrides case-insensitively. Previously, a base `Authorization` header and a request-specific `authorization` header survived as separate object keys and were combined into an invalid comma-separated credential by `Headers`.
