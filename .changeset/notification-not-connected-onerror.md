---
'@modelcontextprotocol/core': patch
---

`Protocol.notification()` now routes to `onerror` instead of throwing when called after the transport has closed. This matches the existing behavior of the debounced notification path and prevents unhandled rejections when long-running handlers send progress notifications after a client disconnects.
