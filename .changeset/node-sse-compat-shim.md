---
'@modelcontextprotocol/node': patch
---

Restore the legacy `SSEServerTransport` under the `@modelcontextprotocol/node/sse` subpath as a deprecated v1-compat shim. Servers using the HTTP+SSE transport can upgrade by changing the import to `@modelcontextprotocol/node/sse`. New code should use `NodeStreamableHTTPServerTransport`.
