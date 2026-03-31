---
'@modelcontextprotocol/core': patch
---

Consolidate per-request cleanup in `_requestWithSchema` into a single `.finally()` block. This fixes an abort signal listener leak (listeners accumulated when a caller reused one `AbortSignal` across requests) and two cases where `_responseHandlers` entries leaked on send-failure paths.
