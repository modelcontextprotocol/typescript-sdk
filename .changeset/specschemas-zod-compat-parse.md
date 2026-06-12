---
"@modelcontextprotocol/core": minor
"@modelcontextprotocol/client": minor
"@modelcontextprotocol/server": minor
---

Expose Zod-compatible `parse()` / `safeParse()` on every `specTypeSchemas` entry. The schemas are still typed as Standard Schema (`['~standard'].validate()` remains the recommended, library-agnostic API), but the underlying runtime values are Zod schemas, so these two methods are now surfaced with their original behavior — `parse()` returns the typed value or throws a `ZodError`, `safeParse()` returns the `{ success, data } | { success, error }` result. This lets code written against the previous top-level `*Schema` exports migrate by a reference rename (`CallToolResultSchema.parse(x)` → `specTypeSchemas.CallToolResult.parse(x)`) with identical behavior, instead of being rewritten to `['~standard'].validate()` with manual remapping of `.success`/`.data`/`.error`. Only these two methods are exposed; the rest of the Zod schema surface stays internal.
