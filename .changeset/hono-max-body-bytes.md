---
"@modelcontextprotocol/hono": patch
---

Add `maxBodyBytes` option (default: 1_000_000) to cap JSON request body parsing and return 413 when exceeded.

