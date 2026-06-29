---
'@modelcontextprotocol/server': patch
---

Fixed `StreamableHTTPServerTransport` rejecting `Accept: application/json` requests with 406 when `enableJsonResponse: true`. In JSON response mode the server never opens an SSE stream, so requiring `text/event-stream` in the Accept header is incorrect. The Accept check now only requires `application/json` when `enableJsonResponse` is true, and continues to require both media types in the default SSE streaming mode.
