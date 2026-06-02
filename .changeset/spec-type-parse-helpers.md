---
'@modelcontextprotocol/core': minor
---

Add `parseSpecType` and `safeParseSpecType` helpers (exported from `@modelcontextprotocol/client` and `@modelcontextprotocol/server`) as drop-in shaped replacements for v1's `<TypeName>Schema.parse()` / `.safeParse()`. `parseSpecType('CallToolResult', value)` returns the parsed value or throws `SpecTypeValidationError` (with `.issues`); `safeParseSpecType` returns a `{ success, data | issues }` discriminated union so migrated call sites keep their control flow. Both are synchronous.
