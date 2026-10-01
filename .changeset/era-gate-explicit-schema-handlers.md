---
'@modelcontextprotocol/client': patch
'@modelcontextprotocol/server': patch
---

A server can now serve, and a client can now call, `tasks/get` and `tasks/cancel` of the Tasks extension (SEP-2663) on a 2026-07-28 connection, when the handler is registered and the request is sent with an explicit schema. Every other method that a protocol revision removed is still refused. If one server factory serves both eras and such a handler is meant for 2025-era clients only, register it only when `ctx.era === 'legacy'`.
