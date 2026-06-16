---
'@modelcontextprotocol/core': minor
'@modelcontextprotocol/server': minor
---

Results of the cacheable 2026-07-28 operations (`tools/list`, `prompts/list`, `resources/list`, `resources/templates/list`, `resources/read`, `server/discover`) now always carry the revision's required `ttlMs`/`cacheScope` fields when served on that revision, defaulting to `ttlMs: 0` / `cacheScope: 'private'`. Servers can configure the emitted values with the new `ServerOptions.cacheHints` option (per operation) and the new `cacheHint` member of the `registerResource` config (per resource); cache fields returned by a handler win over configured hints, and configured hints are validated at construction/registration time (`RangeError` on invalid values). Responses on 2025-era connections are unchanged and never carry these fields. Note for untyped callers: `registerResource` now interprets a `cacheHint` key in its config object — it is validated and kept out of the resource's list metadata, where it was previously passed through as ordinary metadata.
