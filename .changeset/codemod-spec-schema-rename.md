---
"@modelcontextprotocol/codemod": patch
---

The v1→v2 codemod now migrates spec-schema `.parse()` / `.safeParse()` usage by renaming the schema reference to `specTypeSchemas.X` and leaving the call and its result access untouched, instead of rewriting to `['~standard'].validate()` and remapping `.success`/`.data`/`.error`. This pairs with `specTypeSchemas` entries now exposing those Zod-compatible methods, so the migration is a behavior-preserving rename: `.parse()` still throws on invalid input and `.safeParse()` keeps its discriminated result, with no `.parse()` sites left unmigrated. Other Zod methods that are not exposed on the entry (e.g. `.extend`, `.parseAsync`) are renamed and flagged inline for manual rewrite.
