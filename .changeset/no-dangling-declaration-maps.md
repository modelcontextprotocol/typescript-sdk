---
'@modelcontextprotocol/core': patch
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
'@modelcontextprotocol/server-legacy': patch
'@modelcontextprotocol/codemod': patch
'@modelcontextprotocol/express': patch
'@modelcontextprotocol/fastify': patch
'@modelcontextprotocol/hono': patch
'@modelcontextprotocol/node': patch
---

Stop shipping broken declaration source maps (`.d.mts.map`/`.d.cts.map`). The published
packages only include `dist/`, so the declaration maps pointed at `src/` paths (and the
private `core-internal` workspace package) that do not exist in the tarball and carried no
embedded source content — declaration-map-aware tooling could only ever resolve them to
"source not found". The declaration maps and their `sourceMappingURL` references are no
longer emitted; runtime JS source maps (which embed `sourcesContent`) are unchanged.
