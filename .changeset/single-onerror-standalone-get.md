---
'@modelcontextprotocol/client': patch
---

`StreamableHTTPClientTransport` no longer reports the same standalone GET failure to `onerror` twice, including when `close()` aborts an in-flight stream.
