---
'@modelcontextprotocol/core': patch
'@modelcontextprotocol/server': patch
'@modelcontextprotocol/client': patch
---

Fix runtime crash on `tools/list` when a tool's `inputSchema` comes from zod 4.0–4.1. The SDK requires `~standard.jsonSchema` (StandardJSONSchemaV1, added in zod 4.2.0); previously a missing `jsonSchema` crashed at `undefined[io]`. `standardSchemaToJsonSchema` now detects zod 4 schemas lacking `jsonSchema` and falls back to the SDK-bundled `z.toJSONSchema()`, emitting a one-time console warning. zod 3 schemas (which the bundled zod 4 converter cannot introspect) and non-zod schema libraries without `jsonSchema` get a clear error pointing to `fromJsonSchema()`. The workspace zod catalog is also bumped to `^4.2.0`.
