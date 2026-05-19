---
'@modelcontextprotocol/server': patch
'@modelcontextprotocol/client': patch
---

Stop bundling `@cfworker/json-schema` into the main package barrel. Previously `CfWorkerJsonSchemaValidator` was re-exported from the core internal barrel, so tsdown inlined the `@cfworker/json-schema` dev dependency into every consumer's bundle even when it was never used. The validator is now reachable only via the `_shims` conditional (workerd/browser), so consumers that don't opt into it no longer ship that code. The interim `@modelcontextprotocol/{server,client}/validators/cf-worker` subpath this introduced has been removed in a follow-up — the runtime shim is now the only entry point.
