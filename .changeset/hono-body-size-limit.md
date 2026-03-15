---
'@modelcontextprotocol/hono': patch
---

Add `maxBodyBytes` option to `createMcpHonoApp()` and enforce a default JSON request body size limit (413 on oversized payloads).

