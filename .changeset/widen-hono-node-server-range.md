---
'@modelcontextprotocol/node': patch
---

Widen the `@hono/node-server` range to `^1.19.9 || ^2.0.5` so installs can resolve past GHSA-frvp-7c67-39w9 (Windows-only path traversal in `serve-static`, moderate severity; fixed in 2.0.5 — no patched 1.x exists). This mirrors the v1.x fix (#2549, shipped in 1.30.0), which was merged on a branch that does not use changesets and therefore could not propagate here. `getRequestListener` — the only symbol this package imports — keeps the same signature and contract in 2.x, the root entry's exports are a superset of 1.x's, and the `hono@^4` peer is the same; 2.x does drop the `./vercel` subpath and ships `.d.mts`/`.d.cts` declarations only, neither of which this package relies on. `@hono/node-server@2` requires Node >= 20, matching this package's existing engines floor.
