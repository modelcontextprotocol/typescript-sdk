---
status: scaffold
shape: how-to
---
# Test a server

<!-- SCAFFOLD - structure only; prose comes in a later tranche.
scope: In-memory linked pair + handler.fetch — no sockets.
teaches: createMcpHandler, McpHttpHandler.fetch, StreamableHTTPClientTransportOptions.fetch, Client, InMemoryTransport.createLinkedPair, serveStdio
source: mined from docs/migration/support-2026-07-28.md "In-process testing"; relocated here per agent-report 89 §5 hole 4 ("No testing guide")
-->

## Serve the handler in-process
<!-- teaches: createMcpHandler + StreamableHTTPClientTransport fetch option | salvage: docs/migration/support-2026-07-28.md "In-process testing" -->
Pass `handler.fetch` as the client transport's `fetch` — the URL is never dialed; every request is served in-process, no port, no socket.

```ts
// draft - API verified against packages/server/src/server/createMcpHandler.ts (createMcpHandler L575, McpServerFactory L115, McpHttpHandler.fetch L214) and packages/client/src/client/streamableHttp.ts (StreamableHTTPClientTransportOptions.fetch L184)
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const handler = createMcpHandler(() => new McpServer({ name: 'app', version: '1.0.0' }));
const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
  fetch: (url, init) => handler.fetch(new Request(url, init)),
});
```
<!-- result: connecting a Client over this transport exercises the real 2026-07-28 HTTP path with zero network -->

## Connect a client and call a tool
<!-- teaches: Client.connect, Client.callTool -->
<!-- code: new Client({...}) + await client.connect(transport) + await client.callTool({ name, arguments }) -->

## Assert on the result
<!-- teaches: CallToolResult.content, structuredContent, isError | salvage: docs/server.md "Tools" result shape -->
<!-- code: expect(result.structuredContent).toEqual(...) and the isError-true branch -->

## Tear down between tests
<!-- teaches: handler.close, Client.close | salvage: docs/migration/support-2026-07-28.md McpHttpHandler.close -->
<!-- code: afterEach: await client.close(); await handler.close() -->

## Pair two instances in memory
<!-- teaches: InMemoryTransport.createLinkedPair | salvage: docs/migration/support-2026-07-28.md "In-process testing" ("connects 2025-era instances only") -->
<!-- code: const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair(); connect a Server and a Client to each end -->
<!-- era caveat: ONE line linking /protocol-versions — the linked pair is 2025-era only; use handler.fetch for 2026-07-28 coverage -->

## Cover stdio by spawning the process
<!-- teaches: serveStdio under a child process, StdioClientTransport | salvage: docs/migration/support-2026-07-28.md "In-process testing" final line -->
<!-- code: StdioClientTransport({ command: 'node', args: ['dist/server.js'] }) -->

## Recap
<!-- the claims this page will prove:
- handler.fetch serves a Request in-process; the transport URL is never dialed.
- One Client + one createMcpHandler is a complete no-socket integration test.
- InMemoryTransport.createLinkedPair() pairs 2025-era instances; it is not a 2026-era entry.
- stdio coverage means spawning the real process.
- Close the client and the handler between tests.
-->
