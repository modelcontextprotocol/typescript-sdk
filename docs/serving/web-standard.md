---
shape: how-to
---
# Serve on web-standard runtimes

```sh
npm install @modelcontextprotocol/server
```

## Mount the handler

`createMcpHandler` returns a `{ fetch }` object — the shape Cloudflare Workers, Deno, and Bun expect from a module's default export — so `export default handler` mounts it.

```ts source="../../examples/guides/serving/webStandard.examples.ts#createMcpHandler_exportDefault"
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

export default handler;
```

The deployed worker answers MCP requests on every path, with no Node adapter and no body middleware. The factory runs once per request, so a fresh `McpServer` serves every call: [Serve over HTTP](./http.md#understand-the-per-request-factory) covers that model.

## Protect against DNS rebinding

The handler performs no `Host` or `Origin` validation, and on a bare fetch-native runtime there is no app factory to arm it for you. Put the framework-agnostic response helpers in front of `fetch`.

```ts source="../../examples/guides/serving/webStandard.examples.ts#hostHeaderValidationResponse_guard"
import { hostHeaderValidationResponse, originValidationResponse } from '@modelcontextprotocol/server';

const guarded = {
    async fetch(request: Request): Promise<Response> {
        const rejected =
            hostHeaderValidationResponse(request, ['api.example.com']) ??
            originValidationResponse(request, ['app.example.com']);
        return rejected ?? handler.fetch(request);
    }
};
```

A request whose `Host` is not on the list gets `403` before `handler.fetch` runs; both helpers take hostnames, port-agnostic, and a request without an `Origin` header always passes. For a localhost-only process, `localhostAllowedHostnames()` and `localhostAllowedOrigins()` (same package) replace the explicit lists.

## Forward auth and the parsed body

There is no body middleware on a fetch-native runtime — `fetch` reads the `Request` itself, so there is no `parsedBody` to forward. The handler never derives auth from request headers either: verify the token yourself and pass the result as `fetch`'s second argument, and handlers read it as `ctx.http.authInfo`.

```ts source="../../examples/guides/serving/webStandard.examples.ts#McpHttpHandler_fetch_authInfo"
const secured = {
    async fetch(request: Request): Promise<Response> {
        const authInfo = await verifyToken(request);
        return handler.fetch(request, { authInfo });
    }
};
```

`verifyToken` is your token verification. [Authorization](./authorization.md) covers verifying bearer tokens and serving the OAuth metadata documents.

## Run it and verify

Deploy the default export on your runtime — `wrangler dev server.ts` puts it on `http://127.0.0.1:8787`; `deno serve server.ts` and `bun run server.ts` serve the same `{ fetch }` shape. POST a `tools/list` request to it.

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

- One install line, one file: the handler `createMcpHandler` returns is already the `{ fetch }` default export web-standard runtimes serve.
- No Node adapter and no body middleware are involved.
- A fresh server instance from your factory serves every request.
- The handler does no `Host`/`Origin` validation; on a bare runtime, put `hostHeaderValidationResponse` and `originValidationResponse` in front of it.
- Auth is pass-through via `handler.fetch`'s second argument; handlers read it as `ctx.http.authInfo`.
