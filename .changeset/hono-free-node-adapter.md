---
'@modelcontextprotocol/node': patch
---

Remove the `@hono/node-server` and `hono` dependencies. `NodeStreamableHTTPServerTransport` now reuses the package's existing Node/Web request adapter, so importing `@modelcontextprotocol/node` no longer installs or loads Hono. Response headers are flushed before streaming so long-lived SSE connections begin before the first event.
