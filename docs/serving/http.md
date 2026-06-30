---
status: scaffold
shape: how-to
---
# Serve over HTTP

<!-- SCAFFOLD - structure only; prose comes in a later tranche.
scope: createMcpHandler; the per-request factory model lives HERE (recipes link back).
teaches: createMcpHandler, McpServerFactory, McpRequestContext, McpHttpHandler.fetch, toNodeHandler, CreateMcpHandlerOptions (responseMode, onerror), handler.close
era/legacy note: the legacy: posture is owned by serving/legacy-clients.md (proposal §1); this page carries one aside that links it.
section-top note (proposal §3 path 2): the approved tree has no serving/ landing page, so the
two-sentence transport orientation ("launched locally by a host -> stdio; hosted for many
clients -> HTTP") lives at first-server.md's exit ("Pick a transport"); "atop the serving
section" needs a sidebar/section-blurb decision in the site tranche, not a new page.
source: mined from docs/server.md "Streamable HTTP" + "Serving the 2026-07-28 draft revision over HTTP" + "DNS rebinding protection" + "Shutdown"
-->

## Create a handler
<!-- teaches: createMcpHandler | salvage: docs/server.md "Serving the 2026-07-28 draft revision over HTTP" -->

```ts
// draft - API verified against packages/server/src/server/createMcpHandler.ts
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';

const handler = createMcpHandler(() => {
  const server = new McpServer({ name: 'notes', version: '1.0.0' });
  // server.registerTool(...) — a fresh instance serves every request
  return server;
});
```
<!-- result: one line — handler.fetch is a web-standard (Request) => Promise<Response>; nothing is listening yet -->
<!-- aside (::: info Coming from v1?): createMcpHandler replaces the per-request StreamableHTTPServerTransport + connect() wiring — run the codemod, then see /migration/upgrade-to-v2. -->

## Understand the per-request factory
<!-- teaches: McpServerFactory, McpRequestContext ({ era, authInfo, requestInfo }); factories must be cheap and side-effect-free. THE canonical home of the factory model — all four recipe pages back-link here -->
<!-- code: factory reading ctx — createMcpHandler(({ authInfo }) => buildServerFor(authInfo)) -->

## Mount it on your runtime
<!-- teaches: handler.fetch (Workers/Deno/Bun: export default handler) vs toNodeHandler(handler) for Express/Fastify/node:http | salvage: docs/server.md "handler.fetch is a web-standard..." paragraph -->
<!-- code: createServer(toNodeHandler(handler)).listen(3000) -->
<!-- link strip: /serving/express · /serving/hono · /serving/fastify · /serving/web-standard -->

## Validate Host and Origin in front of it
<!-- teaches: the entry does NO Host/Origin validation or token verification itself; createMcp*App factories arm it by default | salvage: docs/server.md "DNS rebinding protection" -->
<!-- code: createMcpExpressApp() / hostHeaderValidationResponse for bare fetch runtimes -->

## Pass authentication through
<!-- teaches: handler.fetch(request, { authInfo }) / toNodeHandler forwards req.auth; read it as ctx.http.authInfo | salvage: docs/server.md "Options:" paragraph + "Authorization (OAuth resource server)" -->
<!-- code: app.all('/mcp', auth, (req, res) => void node(req, res, req.body)) — one line; link /serving/authorization -->

## Shape the response stream
<!-- teaches: responseMode 'auto' (default) | 'sse' | 'json'; 'json' drops mid-call notifications -->
<!-- code: createMcpHandler(factory, { responseMode: 'json' }) -->
<!-- aside (::: info): older clients are served statelessly by default; the `legacy:` option and the
     full story live on /serving/legacy-clients. Era detail is one line linking /protocol-versions. -->

## Shut down
<!-- teaches: handler.close() aborts in-flight modern exchanges | salvage: docs/server.md "Shutdown" -->
<!-- code: process.on('SIGINT', () => handler.close()) -->

## Recap
<!-- the claims this page proves:
- createMcpHandler(factory) returns { fetch, close, notify, bus }; fetch is web-standard.
- One fresh server instance per request — define tools once in the factory.
- export default on web-standard runtimes; toNodeHandler once for Node frameworks.
- The handler does no Host/Origin validation and no token verification; mount those in front.
- responseMode shapes the response stream; 'json' drops mid-call notifications.
-->
