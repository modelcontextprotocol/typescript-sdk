---
'@modelcontextprotocol/server': major
'@modelcontextprotocol/node': minor
---

`createMcpHandler` now returns a web-standards-only `{ fetch, close, notify, bus }` handler — the shape Workers/Bun/Deno expect from `export default`. The duck-typed `.node(req, res, parsedBody?)` face is removed; Node frameworks (Express, Fastify, plain `node:http`) wrap the
handler once with the new `toNodeHandler(handler, { onerror? })` exported from `@modelcontextprotocol/node`, which converts the Node request to a web-standard `Request`, calls `handler.fetch`, and writes the `Response` back honoring write backpressure. The optional `onerror`
receives the adapter-level error fallback (request conversion / `handler.fetch` throw) before the `500` response is written, restoring observability parity with the removed `.node` face. `NodeIncomingMessageLike` and `NodeServerResponseLike` move from
`@modelcontextprotocol/server` to `@modelcontextprotocol/node`.
