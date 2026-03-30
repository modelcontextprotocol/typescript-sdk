---
'@modelcontextprotocol/client': patch
---

Continue OAuth metadata discovery on 502 (Bad Gateway) responses, matching the existing behavior for 4xx. This fixes MCP servers behind reverse proxies that return 502 for path-aware metadata URLs. Other 5xx errors still throw to avoid retrying against overloaded servers.
