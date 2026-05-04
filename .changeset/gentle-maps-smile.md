---
'@modelcontextprotocol/client': patch
---

Clear stale Streamable HTTP client sessions when a session-bound request receives HTTP 404 by clearing the stored session ID, so the next initialize flow can proceed without an MCP session header.
