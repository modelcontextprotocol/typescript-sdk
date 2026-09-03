---
'@modelcontextprotocol/sdk': patch
---

Fix `registerTool` / `registerPrompt` silently dropping `inputSchema` and `outputSchema` when given a `z.discriminatedUnion(...)` or `z.union(...)` of objects.

`normalizeObjectSchema` previously returned `undefined` for any schema whose root was not `z.object(...)`, so the schema never reached `toJsonSchemaCompat` and `tools/list` advertised an empty schema. Tool calls still validated correctly via the fallback in `validateToolInput`,
which masked the bug.

`normalizeObjectSchema` now passes discriminated unions and unions through unchanged. The `tools/list` payload is also given a top-level `type: "object"` when missing so the emitted JSON Schema satisfies the MCP spec for tool input/output schemas (Zod emits `oneOf` / `anyOf`
without a root type for these cases).

Closes #1643.
