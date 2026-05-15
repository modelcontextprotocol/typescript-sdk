---
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server': minor
---

Export `isSpecType` and `specTypeSchemas` records for runtime validation of any MCP spec type by name. `isSpecType.ContentBlock(value)` is a type predicate; `specTypeSchemas.ContentBlock` is a `StandardSchemaV1Sync<ContentBlock>` validator — `validate()` returns the result synchronously. Guards are standalone functions, so `arr.filter(isSpecType.ContentBlock)` works. Also export the `SpecTypeName`, `SpecTypes`, and `StandardSchemaV1Sync` types.
