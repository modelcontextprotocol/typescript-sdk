---
'@modelcontextprotocol/server': patch
---

Fix a stack overflow in `createMcpHandler` when the factory returns the same server instance for more than one request. Returning a fresh instance per request is still required.
