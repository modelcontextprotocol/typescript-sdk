---
"@modelcontextprotocol/core": patch
---

Fix JSON schema generation from empty Zod objects for OpenAI strict mode compatibility.

When converting Zod schemas to JSON Schema, object schemas now always include the
`required` field, even when empty. This is necessary for compatibility with OpenAI's
strict JSON schema mode, which requires `required` to always be present.

Fixes #1659.
