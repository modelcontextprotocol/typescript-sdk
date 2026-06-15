---
'@modelcontextprotocol/codemod': patch
---

The v1→v2 codemod now migrates the removed `StreamableHTTPError` to `SdkHttpError` (instead of the base `SdkError`), matching the shipped error type and the migration guide. Diagnostics now point at the typed `error.status` / `error.statusText` accessors and note that unexpected-content-type responses are thrown as the base `SdkError`.
