---
'@modelcontextprotocol/core': minor
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Bundle automatic JSON Schema validator defaults in `@modelcontextprotocol/client` and `@modelcontextprotocol/server` runtime shims.

Client/server select defaults automatically based on the runtime: Node shims use AJV, while browser/workerd shims use `@cfworker/json-schema`. Those backends are bundled into the shim chunks that select them, so consumers do not need to install validator packages or import explicit validators for default behavior. Advanced users can still pass their own `jsonSchemaValidator` interface implementation.

The `@modelcontextprotocol/{client,server}/validators/cf-worker` subpath export has been removed — there is no longer any public entry point for the SDK's built-in validator classes. `AjvJsonSchemaValidator` and `CfWorkerJsonSchemaValidator` are now `@internal` and no longer exported from `@modelcontextprotocol/client` or `@modelcontextprotocol/server` (not even as types). The `jsonSchemaValidator` interface remains the public extension point for custom validators, and example JSDoc snippets no longer demonstrate direct validator instantiation.
