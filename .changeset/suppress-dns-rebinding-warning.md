---
'@modelcontextprotocol/express': patch
'@modelcontextprotocol/hono': patch
---

Add `quiet` option to `createMcpExpressApp` and `createMcpHonoApp` to suppress the DNS rebinding warning when binding to `0.0.0.0` or `::` without `allowedHosts`.
