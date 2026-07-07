---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/server': patch
---

Restore the v1 parse tolerance for `CallToolResult.content`: an inbound legacy-era `tools/call` result without `content` defaults to `[]` instead of failing validation. Deployed servers — accepted by SDK v1 for years — return `structuredContent`-only (or otherwise content-less) results, and the strict parse turned every such call into an `INVALID_RESULT` error before application code could run.

The silent-empty-success hazard the strictness guarded is preserved where it matters: the 2025 era's wire-seam schema refuses to default `content` for a body carrying another result family's vocabulary (`task`, `inputRequests`, `requestState` — the era is frozen, so the list is complete), the strip-on-lift arm still rejects a stripped foreign `resultType` body with no explicit content, and the 2026-era wire schemas stay strict — modern-revision servers have no legacy excuse. Task interop through an explicit result schema is untouched.

Server-side authoring is era-independent: a handler result without `content` (dynamic/JS callers — the TypeScript surface requires it) is normalized to `content: []` before era validation on every leg, reaching the wire spec-valid.
