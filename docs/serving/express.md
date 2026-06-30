---
status: scaffold
shape: how-to
---
# Serve with Express

<!-- SCAFFOLD - structure only; prose comes in a later tranche.
scope: Express recipe — self-contained, install one-liner at top, one back-link to http.md.
teaches: createMcpExpressApp, toNodeHandler, express.json -> req.body, allowedHosts
source: mined from docs/server.md "Serving the 2026-07-28 draft revision over HTTP" (Express mount line) + "DNS rebinding protection"; packages/middleware/express/README.md
-->

```sh
npm install @modelcontextprotocol/server @modelcontextprotocol/express @modelcontextprotocol/node express
```

## Mount the handler
<!-- teaches: toNodeHandler + app.all('/mcp') | salvage: docs/server.md createMcpHandler_node region (Express variant) -->
<!-- back-link (one, mandatory): a fresh server instance serves every request — /serving/http#understand-the-per-request-factory -->

```ts
// draft - API verified against packages/middleware/express/src/express.ts, packages/middleware/node/src/toNodeHandler.ts, packages/server/src/server/createMcpHandler.ts
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import express from 'express';

const handler = createMcpHandler(() => {
  const server = new McpServer({ name: 'notes', version: '1.0.0' });
  // server.registerTool(...)
  return server;
});

const app = createMcpExpressApp();
app.use(express.json());

const node = toNodeHandler(handler);
app.all('/mcp', (req, res) => void node(req, res, req.body));

app.listen(3000);
```
<!-- result: one line — http://127.0.0.1:3000/mcp answers MCP POSTs -->

## Protect against DNS rebinding
<!-- teaches: createMcpExpressApp arms Host + Origin validation for localhost binds; allowedHosts/allowedOrigins for 0.0.0.0 | salvage: docs/server.md "DNS rebinding protection" -->
<!-- code: createMcpExpressApp({ host: '0.0.0.0', allowedHosts: ['api.example.com'] }) -->

## Forward auth and the parsed body
<!-- teaches: the third toNodeHandler arg is the parsed body (express.json -> req.body); requireBearerAuth sets req.auth and toNodeHandler forwards it to ctx.http.authInfo -->
<!-- code: app.all('/mcp', auth, (req, res) => void node(req, res, req.body)) — one line; link /serving/authorization -->

## Run it and verify
<!-- teaches: start the process, point the Inspector (or curl) at http://127.0.0.1:3000/mcp -->
<!-- code: sh placeholder — npx @modelcontextprotocol/inspector --transport http http://127.0.0.1:3000/mcp -->
<!-- result: verbatim tools/list output -->

## Recap
<!-- the claims this page proves:
- One install line, one file: createMcpExpressApp + toNodeHandler(createMcpHandler(factory)).
- toNodeHandler converts the web-standard handler to (req, res, parsedBody) once.
- DNS rebinding protection is on by default for localhost binds.
- Auth is pass-through: req.auth in, ctx.http.authInfo out.
-->
