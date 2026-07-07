---
'@modelcontextprotocol/core-internal': patch
---

Restore the v1 parse tolerance for `CallToolResult.content` on the legacy era and the neutral layer: an inbound `tools/call` result without `content` defaults to `[]` instead of failing validation. Deployed servers — accepted by SDK v1 for years — return `structuredContent`-only (or otherwise content-less) results, and the strict parse turned every such call into an `INVALID_RESULT` error before application code could run. Authoring is unchanged (the TypeScript surface still requires `content`; a structured-only handler result is defaulted and reaches the wire spec-valid as `content: []`). The silent-empty-success hazard the strictness guarded is closed at its actual source instead: the 2025-era codec rejects a stripped foreign `resultType` body or a bare task-shaped body that carries no explicit `content`, and the 2026-era wire schemas stay strict — modern-revision servers have no legacy excuse.
