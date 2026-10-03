---
'@modelcontextprotocol/client': patch
---

When an SSE response stream fails while it is being read, the `SSE stream disconnected` error that `StreamableHTTPClientTransport` passes to `onerror` now carries the original error as its `cause`. The message is unchanged.
