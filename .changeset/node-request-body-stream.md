---
'@modelcontextprotocol/node': patch
---

author: @KKonstantinov

`toWebRequest`, and so `toNodeHandler`, now forwards a `Request` that carries its body as a stream rather than a string, so a long-lived request, such as an open `events/stream`, no longer keeps its body once it has been read. Such a `Request` sent on with `fetch` can no longer replay its body on a 307 or 308 redirect, and one without a `Content-Type` header no longer gets `text/plain;charset=UTF-8`.
