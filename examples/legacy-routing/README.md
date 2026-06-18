# legacy-routing

`isLegacyRequest` routing: keep an **existing** sessionful 1.x Streamable HTTP deployment serving 2025-era clients, add a strict `createMcpHandler({ legacy: 'reject' })` for 2026-07-28 traffic, on the **same port**. The predicate decides per request which arm handles it.

`server.ts` also shows the browser-client CORS `exposedHeaders` recipe and explicit `GET` (standalone SSE stream) / `DELETE` (session termination per the MCP spec) routes for the sessionful arm.

**HTTP-only** by definition; see also `dual-era/` for the simple case where you don't have a sessionful deployment to keep.

## Direct transport construction (without `createMcpHandler`)

If you need full control over the per-request transport on a web-standards runtime (Hono, Cloudflare Workers, …) instead of `createMcpHandler`, construct `WebStandardStreamableHTTPServerTransport` directly:

```ts
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';

const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID()
});
const server = new McpServer({ name: 'direct-transport', version: '1.0.0' });
await server.connect(transport);

// Any Request/Response runtime (fetch handler, Hono `c.req.raw`, …):
export default { fetch: (request: Request) => transport.handleRequest(request) };
```

`NodeStreamableHTTPServerTransport` (used in this story's legacy arm) is the Node.js `IncomingMessage`/`ServerResponse` equivalent.
