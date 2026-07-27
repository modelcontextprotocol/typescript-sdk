---
'@modelcontextprotocol/sdk': patch
---

Fix `tools/list` emitting `inputSchema: {}` (and silently dropping `outputSchema`) for tools whose schema is wrapped in `ZodEffects` / `ZodPipeline` (`.refine`, `.superRefine`, `.transform`, `.pipe`). The emission sites now fall back to the original schema when
`normalizeObjectSchema` can't unwrap, mirroring what `validateToolInput` already does — the converter libraries walk those wrappers natively.
