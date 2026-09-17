# bearer-auth-web

The web-standard twin of [`bearer-auth`](../bearer-auth/): the same minimal
Resource-Server-only story built entirely from `@modelcontextprotocol/server`
exports, with no framework.

Host and origin validation plus `requireBearerAuth` gate `createMcpHandler`,
composed as one `fetch(request)` handler. On Cloudflare Workers, Deno, or Bun
that handler is the whole server; `toNodeHandler` bridges it onto `node:http`
so the story runs in this repo's example matrix.

No Authorization Server and no discovery documents here, matching the sibling
— see [`oauth`](../oauth/) for the full RS + AS dance.

```sh
pnpm --filter @mcp-examples/bearer-auth-web server -- --http --port 3000
pnpm --filter @mcp-examples/bearer-auth-web client -- --http http://127.0.0.1:3000/mcp
```
