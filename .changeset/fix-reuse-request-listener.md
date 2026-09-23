---
'@modelcontextprotocol/node': patch
---

Reuse the constructor's `getRequestListener` in `NodeStreamableHTTPServerTransport.handleRequest()` instead of creating a new one per request. Uses `AsyncLocalStorage` to pass per-request context (authInfo, parsedBody) through to the shared listener callback. This eliminates one `getRequestListener` allocation per HTTP request, reducing GC pressure under sustained load.
