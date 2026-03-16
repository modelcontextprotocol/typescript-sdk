---
"@modelcontextprotocol/sdk": patch
---

Widen `requestedSchema` type in `elicitInput()` to accept standard JSON Schema output from generators like Zod's `.toJSONSchema()`.

Added `additionalProperties` as an explicit optional field and an index signature `[key: string]: unknown` to allow extra JSON Schema fields (e.g., `$schema`, `additionalProperties`) that schema generators commonly produce. Also added `.passthrough()` to the Zod validation schema so these extra fields are preserved at runtime.

Fixes modelcontextprotocol/typescript-sdk#1362
