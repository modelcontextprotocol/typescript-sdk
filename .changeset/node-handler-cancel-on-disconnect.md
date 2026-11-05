---
'@modelcontextprotocol/node': patch
---

`toNodeHandler` cancels the response stream as soon as the client disconnects, instead of at the stream's next chunk. A session's GET stream was held until the next keep-alive write, so a client reconnecting after a dropped connection got 409 and could give up.
