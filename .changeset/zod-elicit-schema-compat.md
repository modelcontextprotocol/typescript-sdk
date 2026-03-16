---
"@modelcontextprotocol/core": patch
---

Allow standard JSON Schema fields in elicitInput requestedSchema

Widen the `requestedSchema` type on `ElicitRequestFormParams` to accept extra
fields such as `$schema` and `additionalProperties` that tools like Zod's
`.toJSONSchema()` produce. Previously these required an `as` cast even though
the runtime accepted them fine.

- Add `.passthrough()` to the Zod schema for `requestedSchema`
- Add `additionalProperties?: boolean` and an index signature to the spec type
