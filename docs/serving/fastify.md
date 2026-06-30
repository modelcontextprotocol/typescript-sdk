---
shape: how-to
---
# Serve with Fastify

```sh
npm install @modelcontextprotocol/server @modelcontextprotocol/fastify @modelcontextprotocol/node fastify
```

## Mount the handler

`createMcpHandler` turns a server factory into a web-standard HTTP handler, and `toNodeHandler` adapts it once to Node's `(req, res)` — a Fastify route hands it `request.raw` and `reply.raw`. `createMcpFastifyApp` is `Fastify()` with DNS rebinding protection already applied.

```ts source="../../examples/guides/serving/fastify.examples.ts#createMcpFastifyApp_mount"
import { createMcpFastifyApp } from '@modelcontextprotocol/fastify';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'notes', version: '1.0.0' });
    server.registerTool(
        'add-note',
        { description: 'Append a note', inputSchema: z.object({ text: z.string() }) },
        async ({ text }) => ({ content: [{ type: 'text', text: `Saved: ${text}` }] })
    );
    return server;
});

const app = createMcpFastifyApp();
const node = toNodeHandler(handler);
app.all('/mcp', (request, reply) => node(request.raw, reply.raw, request.body));
```

`app` is an ordinary Fastify instance with one route — `/mcp` answers every MCP request — and nothing is listening yet. The factory runs once per request, so a fresh `McpServer` serves every call: [Serve over HTTP](./http.md#understand-the-per-request-factory) covers that model.

## Protect against DNS rebinding

A malicious page can DNS-rebind its own domain to `127.0.0.1` and reach a localhost server as if it were same-origin. `createMcpFastifyApp` validates the `Host` and `Origin` headers against that: with the default `127.0.0.1` bind (and `localhost` / `::1`), a request carrying a non-localhost value gets `403` before your handler runs.

Binding to all interfaces drops that default — name the hosts you serve instead.

```ts source="../../examples/guides/serving/fastify.examples.ts#createMcpFastifyApp_allowedHosts"
const publicApp = createMcpFastifyApp({ host: '0.0.0.0', allowedHosts: ['api.example.com'] });
```

`allowedHosts` and `allowedOrigins` take hostnames, port-agnostic. A request without an `Origin` header always passes, so MCP clients outside a browser are unaffected.

## Forward auth and the parsed body

Fastify parses JSON bodies itself, so `request.body` is already the parsed body — passing it as `toNodeHandler`'s third argument keeps the adapter from re-reading the consumed stream. Auth rides on the Node request: set `auth` on `request.raw` and `toNodeHandler` forwards it, so handlers read it as `ctx.http.authInfo`.

```ts source="../../examples/guides/serving/fastify.examples.ts#toNodeHandler_authInfo"
publicApp.all('/mcp', async (request, reply) => {
    const auth = await verifyToken(request.headers.authorization);
    return node(Object.assign(request.raw, { auth }), reply.raw, request.body);
});
```

`verifyToken` is your token verification. [Authorization](./authorization.md) covers verifying bearer tokens and serving the OAuth metadata documents.

## Run it and verify

Add the listen line and start the process (`npx tsx server.ts`).

```ts source="../../examples/guides/serving/fastify.examples.ts#createMcpFastifyApp_listen"
await app.listen({ port: 3000 });
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

- One install line, one file: `createMcpFastifyApp()` plus `app.all('/mcp', …)` over `toNodeHandler(createMcpHandler(factory))`.
- A fresh server instance from your factory serves every request.
- Fastify already parsed `request.body`; pass it as `toNodeHandler`'s third argument.
- The default `127.0.0.1` bind validates `Host` and `Origin`; pass `allowedHosts` when binding to `0.0.0.0`.
- Set `auth` on the raw Node request; `toNodeHandler` forwards it as `ctx.http.authInfo`.
