---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Key compiled JSON Schema validators by the schema body instead of `$id`, so two schemas that share an `$id` but describe different shapes validate independently.
