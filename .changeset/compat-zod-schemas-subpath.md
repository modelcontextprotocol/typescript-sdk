---
'@modelcontextprotocol/server': patch
---

Add `@modelcontextprotocol/server/zod-schemas` subpath for v1 compatibility

Re-exports the `*Schema` Zod constants (e.g. `CallToolRequestSchema`, `JSONRPCMessageSchema`) and the `getRequestSchema(method)` / `getResultSchema(method)` / `getNotificationSchema(method)` lookup helpers, so v1 code that imported schemas from `@modelcontextprotocol/sdk/types.js` can be pointed at a single subpath. These are Zod schemas; their TS type may change with internal Zod upgrades. Prefer `specTypeSchema()` for runtime validation.

The `@modelcontextprotocol/sdk` meta-package (#1913 in this series) re-exports this subpath at `sdk/types.js`, so v1 imports work unchanged once both PRs land.
