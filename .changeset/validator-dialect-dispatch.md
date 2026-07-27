---
'@modelcontextprotocol/server': patch
'@modelcontextprotocol/client': patch
---

The default validator now honors declared 2019-09 and draft-07/06 dialects instead of rejecting them: a schema stamped `"$schema": "http://json-schema.org/draft-07/schema#"` (zod-to-json-schema's default output) validates with draft-07 semantics, and a 2019-09 stamp (zod-to-json-schema's `2019-09`/`openAi` targets) with 2019-09 semantics, on both the Ajv and Cloudflare Workers providers (with known engine differences documented in the migration guide). Schemas with no `$schema` still validate as 2020-12, and unknown dialects still produce the typed error (now listing the supported dialects: 2020-12, 2019-09, draft-07, draft-06).
