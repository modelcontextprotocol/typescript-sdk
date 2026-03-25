---
'@modelcontextprotocol/core': patch
'@modelcontextprotocol/server': patch
---

Add type coercion for tool arguments so string values from LLMs are automatically converted to match the expected JSON Schema type (number, boolean, integer, array, object) before validation. Fixes cases where models send `"42"` instead of `42`.
