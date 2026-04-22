---
'@modelcontextprotocol/server': patch
'@modelcontextprotocol/client': patch
---

Overhaul v1→v2 migration docs: lead with the "just bump `@modelcontextprotocol/sdk` to ^2" path, add prerequisite callouts (zod ^4.2.0, `moduleResolution: bundler|nodenext`, bun cache), and fill mapping-table gaps (`ResourceTemplateType`, `OAuthError.code`, `parseJSONRPCMessage`,
`specTypeSchema`, `ZodRawShapeCompat`, `roots/list`/`tasks/*`/`completion/complete` method strings, `InMemoryTransport`, `callToolStream`, custom-method handlers, transitive-v1-dep guidance).
