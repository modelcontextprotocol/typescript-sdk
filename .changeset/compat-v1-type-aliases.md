---
'@modelcontextprotocol/core': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Add v1 type aliases to the public API surface for smoother migration: `IsomorphicHeaders` (→ `Headers`) and `RequestInfo` (→ `Request`). `FetchLike` retains its v1 name.
