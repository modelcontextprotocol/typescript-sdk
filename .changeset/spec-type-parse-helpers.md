---
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/server': minor
---

Add v1-style `parse`/`safeParse` methods to every `specTypeSchemas` entry, so v1 call sites migrate with a one-line rename: `CallToolResultSchema.parse(value)` becomes `specTypeSchemas.CallToolResult.parse(value)`. `parse` returns the parsed value or throws `SpecTypeValidationError` (an `SdkError` subclass with code `SdkErrorCode.InvalidSpecType`, carrying `.specType` and `.issues`); `safeParse` returns a `{ success, data | issues }` discriminated union so migrated call sites keep their control flow. Both are synchronous, and each entry remains a Standard Schema (`['~standard'].validate`).
