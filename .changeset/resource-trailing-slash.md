---
'@modelcontextprotocol/client': patch
---

`auth()` no longer rejects protected resource metadata whose `resource` differs from the server URL only by a trailing slash (for example a server at `https://host/mcp` advertising `https://host/mcp/`). `checkResourceAllowed` now treats a single trailing slash as insignificant in both directions.
