---
status: scaffold
shape: explanation
---
# Low-level Server

<!-- SCAFFOLD - structure only; prose comes in a later tranche.
scope: Rebuild the Tools example by hand on Server; McpServer-vs-Server decision criteria.
teaches: Server, ServerOptions.capabilities, setRequestHandler (spec-method overload), RequestTypeMap, McpServer.server, McpServerFactory (accepts Server)
source: mined from docs/migration/upgrade-to-v2.md "Low-level protocol & handler context (ctx)" and "setRequestHandler / setNotificationHandler use method strings"; docs/server.md "Tools"
-->

## Build the server and list your tools by hand
<!-- teaches: Server, ServerOptions.capabilities, setRequestHandler('tools/list') | salvage: docs/migration/upgrade-to-v2.md "setRequestHandler / setNotificationHandler use method strings" -->
`Server` gives you the protocol with no registration layer on top: declare the capability, then answer `tools/list` yourself.

```ts
// draft - API verified against packages/server/src/server/server.ts (Server, ServerOptions) and packages/core-internal/src/shared/protocol.ts (setRequestHandler spec-method overload)
import { Server } from '@modelcontextprotocol/server';

const server = new Server({ name: 'catalog', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler('tools/list', async () => ({
  tools: [
    {
      name: 'search',
      description: 'Search the product catalog',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  ],
}));
```
<!-- result: a client's tools/list returns exactly the array you wrote — the SDK derived none of it -->

## Handle `tools/call` yourself
<!-- teaches: setRequestHandler('tools/call'), RequestTypeMap['tools/call'], CallToolResult | salvage: docs/migration/upgrade-to-v2.md "Low-level protocol & handler context (ctx)" -->
<!-- code: setRequestHandler('tools/call', async (request, ctx) => ...) — dispatch on request.params.name, read request.params.arguments, return { content } -->

## Validate arguments yourself
<!-- teaches: what registerTool was doing for you (JSON Schema derivation + pre-handler validation); fromJsonSchema as the halfway point -->
<!-- code: parse request.params.arguments by hand (or fromJsonSchema(inputSchema)['~standard'].validate) before touching it -->

## Serve it with the same entry points
<!-- teaches: McpServerFactory accepts McpServer | Server — serveStdio and createMcpHandler take this Server unchanged | salvage: docs/server.md "Transports" -->
<!-- code: serveStdio(() => server) — identical to the high-level path -->

## Reach the low level from `McpServer`
<!-- teaches: McpServer.server escape hatch; mixing registerTool with hand-registered handlers | salvage: docs/server.md "Extension capabilities" (the server.server idiom) -->
<!-- code: mcp.server.setRequestHandler(...) on an existing McpServer -->

## Decide which layer to build on
<!-- teaches: the criteria — McpServer for tools/resources/prompts (schema payoff, list-changed bookkeeping, completions); Server when you own dispatch (gateways, dynamic tool sets, non-standard registries, custom methods) -->
<!-- code: none — decision prose; ends with the default ruling: start on McpServer, drop down per handler via mcp.server -->

## Recap
<!-- the claims this page will prove:
* Server is the protocol layer: setRequestHandler(method, handler) and nothing else.
* On Server you write the JSON Schema and the validation that registerTool derives from one Zod schema.
* serveStdio and createMcpHandler accept a Server factory unchanged.
* McpServer.server is the escape hatch — you never have to choose for the whole program.
* Default to McpServer; drop to Server only when you own dispatch.
-->
