---
'@modelcontextprotocol/sdk': patch
---

Fix OAuth scope accumulation during progressive authorization: merge previously granted scopes with newly requested scopes instead of overwriting them, preventing loss of access when the server requests additional permissions via 403.
