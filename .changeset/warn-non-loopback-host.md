---
'@modelcontextprotocol/express': patch
'@modelcontextprotocol/hono': patch
'@modelcontextprotocol/fastify': patch
---

`createMcpExpressApp`, `createMcpHonoApp` and `createMcpFastifyApp` now log the "binding without DNS rebinding protection" warning for any non-loopback `host` (a LAN address or a hostname) when `allowedHosts` is not set, not only for `0.0.0.0` and `::`. Behaviour is otherwise unchanged; pass `allowedHosts` to enable Host validation and silence the warning.
