---
'@modelcontextprotocol/node': minor
---

Export `toWebRequest(req, parsedBody?, options?)` — the Node `IncomingMessage` → web-standard `Request` conversion `toNodeHandler` already performs internally. Use it to feed `isLegacyRequest()` (or `handler.fetch()`) from a hand-wired Node/Express `(req, res)` handler instead of assembling a `globalThis.Request` from `req.headers` by hand. When a body parser already consumed the Node stream (`express.json()`), pass the parsed value as `parsedBody`; pass `options.signal` to tie the constructed request to client disconnect, the way `toNodeHandler` does.
