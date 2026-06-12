---
'@modelcontextprotocol/core': patch
---

Pass `reused: 'inline'` when converting Zod schemas to JSON Schema in `tools/list` and prompt argument schemas, so reused subschema instances are inlined rather than emitted as `$ref` pointers. Restores compatibility with strict MCP clients (e.g. kimi) that reject ref forms other than `#/$defs/...`. Fixes #2100.
