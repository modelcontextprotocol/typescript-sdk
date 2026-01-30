---
"@modelcontextprotocol/sdk": patch
---

Fix JSON Schema output to use draft-2020-12 for Zod v3 schemas

The Zod v3 branch of `toJsonSchemaCompat` was not passing a `target` option to `zod-to-json-schema`, causing it to default to draft-07. This breaks compatibility with Claude's API which requires draft-2020-12 compliance.
