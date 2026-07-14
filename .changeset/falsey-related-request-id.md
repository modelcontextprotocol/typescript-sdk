---
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
'@modelcontextprotocol/core-internal': patch
---

Notifications with `relatedRequestId: 0` are now sent immediately instead of being treated as unassociated notifications eligible for debounce coalescing. JSON-RPC request ID `0` is valid and must preserve its request association.
