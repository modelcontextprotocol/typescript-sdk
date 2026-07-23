---
shape: how-to
---
# Serve with Hono

```sh
npm install @modelcontextprotocol/server @modelcontextprotocol/hono hono
```

## Mount the handler

`createMcpHandler` turns a server factory into a web-standard HTTP handler, and `handler.fetch` takes the `Request` a Hono route already holds as `c.req.raw` — no Node adapter. `createMcpHonoApp` is `new Hono()` with JSON body parsing and DNS rebinding protection already applied.

```ts source="../../examples/guides/serving/hono.examples.ts#createMcpHonoApp_mount"
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import type { Context } from 'hono';
import * as z from 'zod/v4';

const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'notes', version: '1.0.0' });
    server.registerTool('add-note', { description: 'Append a note', inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({
        content: [{ type: 'text', text: `Saved: ${text}` }]
    }));
    return server;
});

const app = createMcpHonoApp();
app.all('/mcp', (c: Context) => handler.fetch(c.req.raw, { parsedBody: c.get('parsedBody') }));

export default app;
```

`app` is an ordinary Hono app, and `export default app` is the `{ fetch }` object Cloudflare Workers, Deno, and Bun serve directly; on Node, pass `app` to `serve` from `@hono/node-server`. The factory runs once per request, so a fresh `McpServer` serves every call: [Serve over HTTP](./http.md#understand-the-per-request-factory) covers that model.

::: tip
Keep the explicit `c: Context` annotation: on an inferred callback context `c.get`'s key parameter narrows to `never` and `c.get('parsedBody')` does not compile.
:::

## Protect against DNS rebinding

A malicious page can DNS-rebind its own domain to `127.0.0.1` and reach a localhost server as if it were same-origin. `createMcpHonoApp` validates the `Host` and `Origin` headers against that: with the default `127.0.0.1` bind (and `localhost` / `::1`), a request carrying a non-localhost value gets `403` before your handler runs.

Binding to all interfaces drops that default — name the hosts you serve instead.

```ts source="../../examples/guides/serving/hono.examples.ts#createMcpHonoApp_allowedHosts"
const publicApp = createMcpHonoApp({ host: '0.0.0.0', allowedHosts: ['api.example.com'] });
```

`allowedHosts` and `allowedOrigins` take hostnames, port-agnostic. A request without an `Origin` header always passes, so MCP clients outside a browser are unaffected.

## Forward auth and the parsed body

`createMcpHonoApp` parses JSON bodies into `c.get('parsedBody')` for you; keep passing it through. Auth travels the same way — `handler.fetch`'s second argument is strictly pass-through, and handlers read it as `ctx.http.authInfo`.

```ts source="../../examples/guides/serving/hono.examples.ts#McpHttpHandler_fetch_authInfo"
publicApp.all('/mcp', async (c: Context) => {
    const authInfo = await verifyToken(c.req.raw);
    return handler.fetch(c.req.raw, { authInfo, parsedBody: c.get('parsedBody') });
});
```

`verifyToken` is your token verification. [Authorization](./authorization.md) covers verifying bearer tokens and serving the OAuth metadata documents.

## Run it and verify

Deploy the default export on any runtime that serves a `{ fetch }` object — `wrangler dev server.ts` puts it on `http://127.0.0.1:8787`. POST a `tools/list` request to `/mcp`.

```sh
curl -s -X POST http://127.0.0.1:8787/mcp \
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

- One install line, one file: `createMcpHonoApp()` plus one `app.all('/mcp', …)` route over `createMcpHandler(factory).fetch`.
- Hono hands `c.req.raw` straight to `handler.fetch` — no Node adapter.
- A fresh server instance from your factory serves every request.
- The default `127.0.0.1` bind validates `Host` and `Origin`; pass `allowedHosts` when binding to `0.0.0.0`.
- `authInfo` and `parsedBody` travel in `handler.fetch`'s second argument; handlers read auth as `ctx.http.authInfo`.
