---
status: scaffold
shape: how-to
---
# Serve with Fastify

<!-- SCAFFOLD - structure only; prose comes in a later tranche.
scope: Fastify recipe — same shape as express.md.
teaches: createMcpFastifyApp, toNodeHandler over request.raw/reply.raw, request.body, allowedHosts
source: mined from packages/middleware/fastify/README.md (server.md never names createMcpFastifyApp — net-new wiring against packages/middleware/fastify/src/fastify.ts) + docs/server.md "DNS rebinding protection"
-->

```sh
npm install @modelcontextprotocol/server @modelcontextprotocol/fastify @modelcontextprotocol/node fastify
```

## Mount the handler
<!-- teaches: toNodeHandler over request.raw / reply.raw; Fastify parses JSON by default | salvage: packages/middleware/fastify/README.md "Streamable HTTP endpoint (Fastify)" -->
<!-- back-link (one, mandatory): a fresh server instance serves every request — /serving/http#understand-the-per-request-factory -->

```ts
// draft - API verified against packages/middleware/fastify/src/fastify.ts, packages/middleware/node/src/toNodeHandler.ts, packages/server/src/server/createMcpHandler.ts
import { createMcpFastifyApp } from '@modelcontextprotocol/fastify';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';

const handler = createMcpHandler(() => {
  const server = new McpServer({ name: 'notes', version: '1.0.0' });
  // server.registerTool(...)
  return server;
});

const app = createMcpFastifyApp();
const node = toNodeHandler(handler);
app.all('/mcp', (request, reply) => node(request.raw, reply.raw, request.body));

await app.listen({ port: 3000 });
```
<!-- result: one line — http://127.0.0.1:3000/mcp answers MCP POSTs -->

## Protect against DNS rebinding
<!-- teaches: createMcpFastifyApp arms Host + Origin validation for localhost binds; allowedHosts/allowedOrigins for 0.0.0.0 | salvage: docs/server.md "DNS rebinding protection" -->
<!-- code: createMcpFastifyApp({ host: '0.0.0.0', allowedHosts: ['api.example.com'] }) -->

## Forward auth and the parsed body
<!-- teaches: Fastify already parsed request.body — pass it as toNodeHandler's third arg; attach validated AuthInfo to req.raw.auth (or call node with options) so handlers read ctx.http.authInfo -->
<!-- code: node(request.raw, reply.raw, request.body) — one line; link /serving/authorization -->

## Run it and verify
<!-- teaches: start the process, point the Inspector (or curl) at http://127.0.0.1:3000/mcp -->
<!-- code: sh placeholder — npx @modelcontextprotocol/inspector --transport http http://127.0.0.1:3000/mcp -->
<!-- result: verbatim tools/list output -->

## Recap
<!-- the claims this page proves:
- One install line, one file: createMcpFastifyApp + toNodeHandler(createMcpHandler(factory)).
- Fastify hands the raw req/res pair to the Node adapter; the body is already parsed.
- DNS rebinding protection is on by default for localhost binds.
- Auth is pass-through to ctx.http.authInfo.
-->
