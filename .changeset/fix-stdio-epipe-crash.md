---
'@modelcontextprotocol/server': patch
---

Handle stdout errors (e.g. EPIPE) in `StdioServerTransport` gracefully instead of crashing. When the client disconnects abruptly, the transport now catches the stdout error, surfaces it via `onerror`, and closes.
