---
'@modelcontextprotocol/sdk': patch
---

`StreamableHTTPServerTransport` and `WebStandardStreamableHTTPServerTransport` now write SSE keep-alive comment frames (`: keepalive`) to open SSE streams so idle connections (e.g. the standalone GET stream, or a POST stream during a long-running tool call) are not killed by intermediaries or server idle timeouts. Configurable via the new `keepAliveMs` option (default 15000; set 0 to disable).
