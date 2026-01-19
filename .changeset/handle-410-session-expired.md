---
'@modelcontextprotocol/client': patch
---

Handle HTTP 410 Gone response for expired/stale MCP sessions by clearing the session ID and automatically retrying the request
