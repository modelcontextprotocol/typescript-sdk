---
'@modelcontextprotocol/server': patch
'@modelcontextprotocol/client': patch
---

Remove subpath-only JSON Schema validator provider classes from the root declaration barrels. `AjvJsonSchemaValidator`, `CfWorkerJsonSchemaValidator`, and `CfWorkerSchemaDraft` remain available from the explicit `validators/ajv` and `validators/cf-worker` subpaths, matching the runtime export surface and avoiding CJS declarations that compile and then resolve to `undefined` at runtime.
