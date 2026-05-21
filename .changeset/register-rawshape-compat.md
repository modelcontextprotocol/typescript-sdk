---
'@modelcontextprotocol/core': patch
'@modelcontextprotocol/server': patch
---

`registerTool`/`registerPrompt` accept a raw Zod shape (`{ field: z.string() }`) for `inputSchema`/`outputSchema`/`argsSchema` in addition to a wrapped Standard Schema. Raw shapes are auto-wrapped with `z.object()`. The raw-shape overloads are `@deprecated`; prefer wrapping with `z.object()`.

Also widens the `completable()` constraint from `StandardSchemaWithJSON` to `StandardSchemaV1` so v1's `completable(z.string(), fn)` continues to work.
