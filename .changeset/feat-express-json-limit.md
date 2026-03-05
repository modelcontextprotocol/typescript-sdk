---
'@modelcontextprotocol/express': patch
---

Add `jsonLimit` option to `createMcpExpressApp()` to allow overriding the default JSON body parser limit of 100kb. Accepts a string (e.g., '5mb') or number (bytes).
