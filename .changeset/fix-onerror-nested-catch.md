---
'@modelcontextprotocol/server': patch
---

Fix nested try-catch in StreamableHTTP transport onerror handler to prevent unhandled exceptions from bubbling up.
