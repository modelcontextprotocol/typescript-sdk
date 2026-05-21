---
'@modelcontextprotocol/server': patch
'@modelcontextprotocol/client': patch
---

Stop bundling `@cfworker/json-schema` into the main package barrel. Previously `CfWorkerJsonSchemaValidator` was re-exported from the core internal barrel, so tsdown inlined the `@cfworker/json-schema` dev dependency into every consumer's bundle even when it was never used. The validator is now reachable only via the `_shims` conditional (workerd/browser) and the explicit `@modelcontextprotocol/{server,client}/validators/cf-worker` subpath, so consumers that don't opt into it no longer ship that code. No public API change.
