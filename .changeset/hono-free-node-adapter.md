---
'@modelcontextprotocol/node': patch
---

Remove the `@hono/node-server` and `hono` dependencies. `NodeStreamableHTTPServerTransport` now reuses the package's existing Node/Web request adapter, so importing `@modelcontextprotocol/node` no longer installs or loads Hono. Response headers are flushed before streaming so long-lived SSE connections begin before the first event, and client disconnects cancel idle response streams so their transport state is cleaned up. Request URLs preserve HTTPS from TLS sockets and HTTP/2 scheme metadata.
