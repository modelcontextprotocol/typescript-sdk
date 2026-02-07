---
"@modelcontextprotocol/express": patch
---

Add `maxBodyBytes` option (default: 100kb) to cap JSON request body parsing and return JSON-RPC errors for invalid JSON / oversized payloads.

