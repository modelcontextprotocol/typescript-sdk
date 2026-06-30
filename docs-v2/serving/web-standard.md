---
status: scaffold
shape: how-to
---
# Serve on web-standard runtimes

<!-- SCAFFOLD - structure only; prose comes in a later tranche.
scope: Web-standard runtimes (Workers etc.) recipe — same shape as express.md.
teaches: export default handler ({ fetch }), McpHttpHandler.fetch, hostHeaderValidationResponse/originValidationResponse for bare runtimes
source: mined from docs/server.md "handler.fetch is a web-standard..." paragraph + "DNS rebinding protection" (framework-agnostic helpers); examples/hono/ (web-standard leg)
-->

```sh
npm install @modelcontextprotocol/server
```

## Mount the handler
<!-- teaches: the handler IS the { fetch } object Workers/Deno/Bun expect from export default | salvage: docs/server.md "on Cloudflare Workers, Deno, or Bun, export default handler is all the mounting you need" -->
<!-- back-link (one, mandatory): a fresh server instance serves every request — /serving/http#understand-the-per-request-factory -->

```ts
// draft - API verified against packages/server/src/server/createMcpHandler.ts (McpHttpHandler is the { fetch, close, notify, bus } shape Workers/Bun/Deno expect from export default)
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';

const handler = createMcpHandler(() => {
  const server = new McpServer({ name: 'notes', version: '1.0.0' });
  // server.registerTool(...)
  return server;
});

export default handler;
```
<!-- result: one line — the deployed Worker (or `bun run` / `deno serve` process) answers MCP POSTs on its URL -->

## Protect against DNS rebinding
<!-- teaches: no app factory here — call the framework-agnostic guards before handler.fetch: hostHeaderValidationResponse / originValidationResponse from @modelcontextprotocol/server | salvage: docs/server.md "When mounting a handler bare on a fetch-native runtime..." -->
<!-- code: const rejected = hostHeaderValidationResponse(request, ['api.example.com']); if (rejected) return rejected; -->

## Forward auth and the parsed body
<!-- teaches: route the Request yourself and pass options: handler.fetch(request, { authInfo }); no body middleware exists — fetch reads the Request body itself -->
<!-- code: async fetch(request) { return handler.fetch(request, { authInfo: await verify(request) }); } — link /serving/authorization -->

## Run it and verify
<!-- teaches: wrangler dev / deno serve / bun run, then point the Inspector (or curl) at /mcp -->
<!-- code: sh placeholder — npx @modelcontextprotocol/inspector --transport http http://127.0.0.1:8787/mcp -->
<!-- result: verbatim tools/list output -->

## Recap
<!-- the claims this page proves:
- The handler is already the export-default shape web-standard runtimes expect.
- No Node adapter and no body middleware are involved.
- On a bare runtime you mount Host/Origin validation yourself with the exported response helpers.
- Auth is pass-through via handler.fetch's second argument.
-->
