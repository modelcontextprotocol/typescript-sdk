---
'@modelcontextprotocol/core': patch
---

Widen `requestedSchema` type in `ElicitRequestFormParams` to accept additional JSON Schema fields (e.g., `$schema`, `additionalProperties`) that tools like Zod's `.toJSONSchema()` produce. This removes the need for users to cast through `unknown` when passing Zod-generated schemas to `elicitInput()`.
