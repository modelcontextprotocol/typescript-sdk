---
shape: how-to
---
# Serve with Express

```sh
npm install @modelcontextprotocol/server @modelcontextprotocol/express @modelcontextprotocol/node express
```

## Mount the handler

`createMcpHandler` turns a server factory into a web-standard HTTP handler, and `toNodeHandler` adapts it once to Express's `(req, res)`. `createMcpExpressApp` is `express()` with `express.json()` and DNS rebinding protection already applied.

```ts source="../../examples/guides/serving/express.examples.ts#createMcpExpressApp_mount"
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'notes', version: '1.0.0' });
    server.registerTool('add-note', { description: 'Append a note', inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({
        content: [{ type: 'text', text: `Saved: ${text}` }]
    }));
    return server;
});

const app = createMcpExpressApp();
const node = toNodeHandler(handler);
app.all('/mcp', (req, res) => void node(req, res, req.body));
```

`app` is an ordinary Express app with one route — `/mcp` answers every MCP request — and nothing is listening yet. The factory runs once per request, so a fresh `McpServer` serves every call: [Serve over HTTP](./http.md#understand-the-per-request-factory) covers that model.

## Protect against DNS rebinding

A malicious page can DNS-rebind its own domain to `127.0.0.1` and reach a localhost server as if it were same-origin. `createMcpExpressApp` validates the `Host` and `Origin` headers against that: with the default `127.0.0.1` bind (and `localhost` / `::1`), a request carrying a non-localhost value gets `403` before your handler runs.

Binding to all interfaces drops that default — name the hosts you serve instead.

```ts source="../../examples/guides/serving/express.examples.ts#createMcpExpressApp_allowedHosts"
const publicApp = createMcpExpressApp({ host: '0.0.0.0', allowedHosts: ['api.example.com'] });
```

`allowedHosts` and `allowedOrigins` take hostnames, port-agnostic. A request without an `Origin` header always passes, so MCP clients outside a browser are unaffected.

## Forward auth and the parsed body

`createMcpExpressApp` installed `express.json()`, so `req.body` is the parsed body — passing it as `toNodeHandler`'s third argument keeps the adapter from re-reading the stream Express already consumed. `requireBearerAuth` verifies the bearer token and attaches the result to `req.auth`; `toNodeHandler` forwards it, and handlers read it as `ctx.http.authInfo`.

```ts source="../../examples/guides/serving/express.examples.ts#requireBearerAuth_mount"
import { requireBearerAuth } from '@modelcontextprotocol/express';

const auth = requireBearerAuth({ verifier });
publicApp.all('/mcp', auth, (req, res) => void node(req, res, req.body));
```

`verifier` is your token verification. [Authorization](./authorization.md) covers writing one, requiring scopes, and serving the OAuth metadata documents.

## Run it and verify

Add the listen line and start the process (`npx tsx server.ts`).

```ts source="../../examples/guides/serving/express.examples.ts#createMcpExpressApp_listen"
app.listen(3000);
```

POST a `tools/list` request to the endpoint.

```sh
curl -s -X POST http://127.0.0.1:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The response is a single SSE `message` event carrying the `tools/list` result:

```
event: message
data: {"result":{"tools":[{"name":"add-note","description":"Append a note","inputSchema":{"type":"object","$schema":"https://json-schema.org/draft/2020-12/schema","properties":{"text":{"type":"string"}},"required":["text"]}}]},"jsonrpc":"2.0","id":1}
```

## Recap

- One install line, one file: `createMcpExpressApp()` plus `app.all('/mcp', …)` over `toNodeHandler(createMcpHandler(factory))`.
- A fresh server instance from your factory serves every request.
- `createMcpExpressApp` already runs `express.json()`; pass `req.body` as `toNodeHandler`'s third argument.
- The default `127.0.0.1` bind validates `Host` and `Origin`; pass `allowedHosts` when binding to `0.0.0.0`.
- `requireBearerAuth` sets `req.auth`; `toNodeHandler` forwards it as `ctx.http.authInfo`.
