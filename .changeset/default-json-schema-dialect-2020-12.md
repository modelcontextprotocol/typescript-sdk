---
'@modelcontextprotocol/sdk': patch
---

Default the Zod v4 JSON Schema conversion target to `draft-2020-12` instead of `draft-7`, so generated `inputSchema`/`outputSchema` declare `https://json-schema.org/draft/2020-12/schema`. The unrecognised-target fallback now agrees with that default instead of returning
`draft-7`. This matches the dialect the spec documents for `Tool.outputSchema`, Zod v4's own `toJSONSchema` default, and the v2 SDK. Passing an explicit `target` (including `'draft-7'`) is unchanged.
