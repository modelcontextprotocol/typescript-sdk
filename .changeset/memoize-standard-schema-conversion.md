---
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

Memoize Standard Schema → JSON Schema conversion per schema instance, across `McpServer` instances. In the stateless `createMcpHandler(() => buildServer())` pattern the app builds a fresh `McpServer` per request and re-registers its tools, so the per-instance `_toolInputSchemaJson` memo never hit and every request re-converted every registered tool's schema (once eagerly in `registerTool`, again per `tools/list`). `standardSchemaToJsonSchema` now caches successful conversions process-wide, keyed by schema identity (a `WeakMap`, so entries stay collectible with their schema) and `io` direction: an app that hoists its schemas to module scope converts each schema once per process instead of once per request (53 hoisted tools on a fresh server: ~14–19 ms → ~1 ms). Conversion failures are not cached, and repeat calls return the same object, which callers must treat as read-only. Fixes #2838.
