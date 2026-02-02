---
'@modelcontextprotocol/core': patch
---

Add support for `$schema` and `additionalProperties` fields in `requestedSchema` for elicitation forms. This allows using Zod's `.toJSONSchema()` output directly with `elicitInput()` without TypeScript errors.
