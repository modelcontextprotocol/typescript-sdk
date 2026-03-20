---
'@modelcontextprotocol/server': patch
---

Add Transfer-Encoding: chunked header to SSE responses in WebStandardStreamableHTTPServerTransport. Prevents HTTP/2 PROTOCOL_ERROR with adapters like @hono/node-server that buffer responses and add Content-Length headers.
