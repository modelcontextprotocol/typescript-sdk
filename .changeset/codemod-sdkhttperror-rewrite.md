---
'@modelcontextprotocol/codemod': patch
---

Rewrite `StreamableHTTPError` to `SdkHttpError` (the documented v2 replacement with typed
`.status`/`.statusText`) instead of `SdkError`, and correct the migration guidance the
codemod emits for it.
