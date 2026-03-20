---
'@modelcontextprotocol/client': patch
---

Throw error on auth fallback for non-root AS paths instead of silently using incorrect absolute paths. Fixes URL path prefix loss when authorization server metadata discovery fails.

Fixes modelcontextprotocol/typescript-sdk#1716
