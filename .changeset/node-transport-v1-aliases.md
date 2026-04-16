---
'@modelcontextprotocol/node': patch
---

Add v1-compat re-exports: `StreamableHTTPServerTransport` (alias for `NodeStreamableHTTPServerTransport`) and the `EventStore` / `EventId` / `StreamId` types, so v1 imports from `@modelcontextprotocol/sdk/server/streamableHttp.js` map cleanly onto `@modelcontextprotocol/node`.
