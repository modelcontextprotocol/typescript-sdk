---
'@modelcontextprotocol/server': minor
'@modelcontextprotocol/node': patch
'@modelcontextprotocol/express': patch
'@modelcontextprotocol/fastify': patch
'@modelcontextprotocol/hono': patch
---

A `Server` or `McpServer` now serves one connection at a time, and a Streamable HTTP server transport without sessions (`sessionIdGenerator: undefined`) serves one request. An app that uses one server object, or one stateless transport, for every HTTP request fails on the second request after this upgrade. Build the server and the transport per request instead.

What keeps working without a change:

- `createMcpHandler(buildServer)` and `serveStdio(buildServer)`, where `buildServer` returns a new server on every call.
- A handler that builds a new server and a new stateless transport for each request.
- One server and one transport per session (a transport with a `sessionIdGenerator`).
- Connecting a server again after `close()`.
- `Client`.

What fails now, how it shows, and what to change:

- One server object with a new stateless transport per request (`const server = new McpServer(...)` outside the handler, `await server.connect(transport)` inside it): the second HTTP request the process receives fails, and so does every later one. `connect()` rejects with an `SdkError` of code `ALREADY_CONNECTED`. If the handler closes the transport when the response ends, requests that arrive one after the other still work and a request that overlaps another one fails. Change: move `new McpServer(...)` and its registrations into the handler.
- One stateless transport for every request (a transport built once with `sessionIdGenerator: undefined`): the second HTTP request fails. `WebStandardStreamableHTTPServerTransport.handleRequest()` rejects with `Stateless transport cannot be reused across requests. Create a new transport per request.`, and `NodeStreamableHTTPServerTransport.handleRequest()` answers `500`. Change: build the server and the transport inside the handler and connect them there.
- `createMcpHandler(() => server)` with a server built once: a request that arrives after the previous response has been read to its end still works. A request that arrives while another one is being served is answered `500` with the JSON-RPC error `-32603` (`Internal server error`); the reason is reported only through the `onerror` option. Change: pass a function that builds the server, as in `createMcpHandler(buildServer)`.
- One server object for every session: the `initialize` request of the second session fails with `ALREADY_CONNECTED`. Change: build a server per session.

What the caller sees when `connect()` or `handleRequest()` rejects depends on the host. Express 5, Fastify and Hono answer `500`. A plain `node:http` listener without its own error handling gets an unhandled rejection, which ends the process.

The README examples of `@modelcontextprotocol/express`, `@modelcontextprotocol/fastify`, `@modelcontextprotocol/hono` and `@modelcontextprotocol/node`, and the handler examples in the JSDoc of `WebStandardStreamableHTTPServerTransport` and `NodeStreamableHTTPServerTransport`, now build a server and a transport per request.
