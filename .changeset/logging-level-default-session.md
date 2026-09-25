---
'@modelcontextprotocol/server': patch
---

Make `sendLoggingMessage(params)` honor the level a client set with `logging/setLevel` on session-bearing transports. The `logging/setLevel` handler stores the level under the transport's session id, but `sendLoggingMessage` looked it up under the `sessionId` argument, which is `undefined` when omitted, as in the documented example. On Streamable HTTP and SSE every message was sent regardless of the client's level, while the same call filtered correctly on stdio. When no `sessionId` is passed, the lookup now uses the connected transport's session id. Passing one explicitly works as before.
