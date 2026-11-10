---
'@modelcontextprotocol/server': patch
---

`readRequestBody`, and with it `createMcpHandler` and the Streamable HTTP transport, now reads request bodies in runtimes that have no `Request.body` stream, such as Firefox. Previously every POST there was answered `400` with a JSON-RPC parse error (`-32700`). In those runtimes the body is read whole and then checked against `maxRequestBodySize`, so oversized bodies are still answered `413`.
