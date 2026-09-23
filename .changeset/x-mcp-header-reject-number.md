---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

`x-mcp-header` on a `number`-typed tool parameter is now rejected, matching the 2026-07-28 spec ("Parameters with type `number` are not permitted"; clients MUST exclude such tools from `tools/list`). Previously `number` was accepted only to satisfy an older conformance fixture that has since been corrected. `integer`, `string` and `boolean` are unaffected.
