---
'@modelcontextprotocol/node': patch
---

Mark `hono` peer dependency as optional. `@modelcontextprotocol/node` only uses `getRequestListener` from `@hono/node-server` (Node HTTP ↔ Web Standard conversion), which does not require the `hono` framework at runtime. Consumers no longer need to install `hono` to use `NodeStreamableHTTPServerTransport`. Note: `@hono/node-server` itself still declares `hono` as a hard peer, so package managers may emit a warning; this is upstream and harmless for `getRequestListener`-only usage.
