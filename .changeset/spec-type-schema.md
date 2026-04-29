---
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server': minor
---

Export `isSpecType` and `specTypeSchema` for runtime validation of any MCP spec type by name. `isSpecType('ContentBlock', value)` is a type predicate; `specTypeSchema('ContentBlock')` returns a `StandardSchemaV1<ContentBlock>` validator. Also export the `StandardSchemaV1`,
`SpecTypeName`, and `SpecTypes` types.
