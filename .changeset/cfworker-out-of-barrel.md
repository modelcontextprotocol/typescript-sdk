---
'@modelcontextprotocol/server': patch
'@modelcontextprotocol/client': patch
---

Stop bundling `@cfworker/json-schema` into the main package barrel. Previously `CfWorkerJsonSchemaValidator` was re-exported from the core internal barrel, so tsdown inlined the `@cfworker/json-schema` dependency into every consumer's bundle even when it was never used. The named validator classes are now reachable only via the explicit `@modelcontextprotocol/{client,server}/validators/{ajv,cf-worker}` subpaths and the runtime `_shims` conditional, so consumers that import only from the root entry point no longer ship the validator dep.
