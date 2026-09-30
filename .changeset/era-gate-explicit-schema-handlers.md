---
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

A server can now serve, and a client can now call, `tasks/get` and `tasks/cancel` of the Tasks extension (SEP-2663) on a 2026-07-28 connection. Register the handler with an explicit schema (`setRequestHandler('tasks/get', { params, result }, handler)`) and send the request with an explicit result schema (`request({ method: 'tasks/get', params }, resultSchema)`). Before, both were refused because the 2025-11-25 revision had these two names in core: `-32601 Method not found` before the handler ran, and `MethodNotSupportedByProtocolVersion` before the request was sent.

Unchanged: every other method that a protocol revision removed (for example `ping`, `initialize`, `tasks/result`, `tasks/list`) is still refused on the era without it, with or without an explicit schema. With no handler, or with a method-keyed handler (`setRequestHandler(method, handler)`), `tasks/get` and `tasks/cancel` still answer `-32601`, and `fallbackRequestHandler` is still not asked for them.

If one server factory serves both eras and an explicit-schema handler for `tasks/get` or `tasks/cancel` is meant for 2025-era clients only (2025-11-25 experimental tasks), register it only when `ctx.era === 'legacy'`: it now answers 2026-07-28 requests too.
