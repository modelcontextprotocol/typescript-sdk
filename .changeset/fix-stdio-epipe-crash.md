---
'@modelcontextprotocol/server': patch
---

Handle EPIPE errors in StdioServerTransport gracefully instead of crashing. When a client disconnects abruptly, the transport now catches stdout write errors, forwards them to `onerror`, and closes cleanly.
