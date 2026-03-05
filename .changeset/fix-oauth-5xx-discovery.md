---
'@modelcontextprotocol/client': patch
---

Continue OAuth metadata discovery on 5xx responses instead of throwing, matching the existing behavior for 4xx. This fixes MCP servers behind reverse proxies that return 502/503 for path-aware metadata URLs.
