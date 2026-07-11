---
'@modelcontextprotocol/server': patch
---

Return JSON-RPC Invalid Params with the original URI and an `invalid_uri` reason when `resources/read` receives a syntactically malformed URI.
