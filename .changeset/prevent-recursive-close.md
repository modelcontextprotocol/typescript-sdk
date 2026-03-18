---
"@modelcontextprotocol/server": patch
---

Prevent stack overflow when multiple transports close simultaneously by guarding against re-entrant close() calls
