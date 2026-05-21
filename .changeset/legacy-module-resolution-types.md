---
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
'@modelcontextprotocol/node': patch
'@modelcontextprotocol/express': patch
'@modelcontextprotocol/fastify': patch
'@modelcontextprotocol/hono': patch
---

Add top-level `types` field (and `typesVersions` on client/server for their subpath exports) so consumers on legacy `moduleResolution: "node"` can resolve type declarations. The `exports` map remains the source of truth for `nodenext`/`bundler` resolution. The `typesVersions` map includes entries for subpaths added by sibling PRs in this series (`zod-schemas`, `stdio`); those entries are no-ops until the corresponding `dist/*.d.mts` files exist.
