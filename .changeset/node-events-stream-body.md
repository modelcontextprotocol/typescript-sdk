---
'@modelcontextprotocol/node': patch
---

author: @KKonstantinov

`toWebRequest`, and so `toNodeHandler`, hands an `events/stream` request (by its `Mcp-Method` header) on with its body as a stream, so an open Events stream keeps none of its body once read. Such a `Request` cannot replay its body on a 307 or 308 redirect, and one without a `Content-Type` header gets no default `text/plain;charset=UTF-8`. Every other request is unchanged.
