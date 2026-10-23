---
'@modelcontextprotocol/sdk': patch
---

Complete the JSON response mode request lifecycle in Streamable HTTP: a completed POST no longer leaks its stream mapping, and close() during an in-flight JSON-mode request settles the pending HTTP response with a 503 JSON-RPC error instead of leaving it hanging until the client times out.
