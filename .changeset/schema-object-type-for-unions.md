---
'@modelcontextprotocol/core': patch
---

Ensure `standardSchemaToJsonSchema` emits `type: "object"` at the root, fixing discriminated-union tool/prompt schemas that previously produced `{oneOf: [...]}` without the MCP-required top-level type. Also throws a clear error when given an explicitly non-object schema (e.g. `z.string()`). Fixes #1643.
