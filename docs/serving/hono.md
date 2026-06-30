---
status: scaffold
shape: how-to
---
# Serve with Hono

<!-- SCAFFOLD - structure only; prose comes in a later tranche.
scope: Hono recipe — same shape as express.md.
teaches: createMcpHonoApp, handler.fetch(c.req.raw), c.get('parsedBody'), allowedHosts
source: mined from docs/server.md "Streamable HTTP" (web-standard mounting paragraph) + "DNS rebinding protection"; packages/middleware/hono/README.md; examples/hono/
-->

```sh
npm install @modelcontextprotocol/server @modelcontextprotocol/hono hono
```

## Mount the handler
<!-- teaches: handler.fetch on c.req.raw — no Node adapter needed | salvage: packages/middleware/hono/README.md "Streamable HTTP endpoint (Hono)" + examples/hono/server.ts -->
<!-- back-link (one, mandatory): a fresh server instance serves every request — /serving/http#understand-the-per-request-factory -->

```ts
// draft - API verified against packages/middleware/hono/src/hono.ts, packages/server/src/server/createMcpHandler.ts
import type { Context } from 'hono';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';

const handler = createMcpHandler(() => {
  const server = new McpServer({ name: 'notes', version: '1.0.0' });
  // server.registerTool(...)
  return server;
});

const app = createMcpHonoApp();
app.all('/mcp', (c: Context) => handler.fetch(c.req.raw, { parsedBody: c.get('parsedBody') }));

export default app;
```
<!-- result: one line — /mcp answers MCP POSTs on whatever runtime serves the Hono app -->
<!-- prose-tranche note: the explicit `c: Context` annotation is load-bearing, not style.
     createMcpHonoApp() returns a plain Hono, so an inferred callback context narrows the
     c.get key parameter to `never` and `c.get('parsedBody')` is a type error (TS2769).
     Keep the annotation until createMcpHonoApp types its Variables env. -->

## Protect against DNS rebinding
<!-- teaches: createMcpHonoApp arms Host + Origin validation for localhost binds; allowedHosts/allowedOrigins for 0.0.0.0 | salvage: docs/server.md "DNS rebinding protection" -->
<!-- code: createMcpHonoApp({ host: '0.0.0.0', allowedHosts: ['api.example.com'] }) -->

## Forward auth and the parsed body
<!-- teaches: createMcpHonoApp parses JSON into c.get('parsedBody'); pass validated auth as handler.fetch(c.req.raw, { authInfo, parsedBody }) -->
<!-- code: (c: Context) => handler.fetch(c.req.raw, { authInfo, parsedBody: c.get('parsedBody') }) — one line; link /serving/authorization -->

## Run it and verify
<!-- teaches: start the process (node/bun/wrangler dev), point the Inspector (or curl) at /mcp -->
<!-- code: sh placeholder — npx @modelcontextprotocol/inspector --transport http http://127.0.0.1:3000/mcp -->
<!-- result: verbatim tools/list output -->

## Recap
<!-- the claims this page proves:
- One install line, one file: createMcpHonoApp + createMcpHandler(factory).fetch.
- Hono hands the raw Request straight to handler.fetch — no Node adapter.
- DNS rebinding protection is on by default for localhost binds.
- Auth is pass-through via the second fetch argument.
-->
