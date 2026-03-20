---
'@modelcontextprotocol/client': patch
---

Clear stale Streamable HTTP client sessions when a session-bound request receives HTTP 404, and tag the thrown SDK error as recoverable (`sessionExpired: true`) so callers can reconnect and re-initialize.
