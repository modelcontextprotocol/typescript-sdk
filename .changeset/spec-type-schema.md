---
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Export `specTypeSchema(name)` and `isSpecType(name, value)` for runtime validation of any MCP spec type by name. `specTypeSchema` returns a `StandardSchemaV1<T>` validator; `isSpecType` is a boolean type predicate. Also export the `StandardSchemaV1`, `SpecTypeName`, and `SpecTypes` types.
