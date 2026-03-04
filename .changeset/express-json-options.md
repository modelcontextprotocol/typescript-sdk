---
'@modelcontextprotocol/express': patch
---

Add `jsonOptions` option to `createMcpExpressApp()` to allow configuring `express.json()` body parser options (e.g. request body size limit).
