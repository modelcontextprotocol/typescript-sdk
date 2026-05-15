---
'@modelcontextprotocol/core': minor
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Make validator backends symmetrical in core and bundle automatic defaults in client/server runtime shims.

Core no longer re-exports concrete validator providers as runtime values from the root/public barrels. AJV/AJV formats and `@cfworker/json-schema` are optional peer backends behind explicit core validator provider subpaths, used internally by client/server shims.

Client/server continue to select defaults automatically: Node shims use AJV, while browser/workerd shims use `@cfworker/json-schema`. Those backends are bundled into the shim chunks that select them, so users do not need to install validator packages or import explicit validators for default behavior. Advanced users can still pass their own `jsonSchemaValidator` implementation.

`AjvJsonSchemaValidator` and `CfWorkerJsonSchemaValidator` are now `@internal` and no longer surface from `@modelcontextprotocol/core/public` (not even as types). The `jsonSchemaValidator` interface remains the public extension point for custom validators. Example JSDoc snippets no longer demonstrate direct validator instantiation.
