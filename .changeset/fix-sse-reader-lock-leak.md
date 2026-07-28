---
'@modelcontextprotocol/sdk': patch
---

Fix SSE client memory leak: release the reader lock on disconnect so the underlying reader-tied buffer (~50MB per long-lived client) can be garbage-collected.
