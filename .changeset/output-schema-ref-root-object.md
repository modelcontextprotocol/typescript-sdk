---
'@modelcontextprotocol/server': patch
---

A tool `outputSchema` whose root is a `$ref` to a `type: "object"` entry of its own `$defs` or `definitions` (what zod writes for `z.object({...}).meta({ id })`), or a union of such refs, is now treated as an object schema. On 2025-era connections the tool's schema and `structuredContent` are no longer wrapped in `{ result: ... }`, so a 2025-era client that read `structuredContent.result` for such a tool now reads `structuredContent`. On every era the advertised schema gains `type: "object"` at its root.
