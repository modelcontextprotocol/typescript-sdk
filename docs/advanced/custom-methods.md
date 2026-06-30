---
status: scaffold
shape: how-to
---
# Custom methods

<!-- SCAFFOLD - structure only; prose comes in a later tranche.
scope: Vendor-prefixed methods, extension capabilities.
teaches: setRequestHandler (3-arg schema overload), RequestHandlerSchemas, Client.request, ctx.mcpReq.notify, setNotificationHandler, registerCapabilities({ extensions }), getServerCapabilities().extensions
source: mined from docs/migration/upgrade-to-v2.md "setRequestHandler / setNotificationHandler use method strings"; docs/server.md "Extension capabilities"; docs/client.md "Extension capabilities"; examples/custom-methods/
-->

## Handle a vendor-prefixed method on the server
<!-- teaches: setRequestHandler('vendor/x', { params, result }, handler) | salvage: docs/migration/upgrade-to-v2.md "setRequestHandler / setNotificationHandler use method strings"; examples/custom-methods/server.ts -->
A non-spec method needs schemas: pass `{ params, result }` as the second argument and the SDK validates both directions.

```ts
// draft - API verified against packages/core-internal/src/shared/protocol.ts (setRequestHandler 3-arg Standard Schema overload) and packages/server/src/server/mcp.ts (McpServer.server)
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const SearchParams = z.object({ query: z.string(), limit: z.number().int().default(10) });
const SearchResult = z.object({ items: z.array(z.string()) });

const mcp = new McpServer({ name: 'acme-search', version: '1.0.0' });

mcp.server.setRequestHandler('acme/search', { params: SearchParams, result: SearchResult }, async ({ query, limit }) => {
  return { items: Array.from({ length: limit }, (_, i) => `${query}-${i}`) };
});
```
<!-- result: the handler receives validated, typed params; a malformed acme/search is rejected before it runs -->

## Call it from the client
<!-- teaches: Client.request({ method, params }, ResultSchema) | salvage: examples/custom-methods/client.ts -->
<!-- code: await client.request({ method: 'acme/search', params: { query: 'mcp', limit: 3 } }, SearchResult) -->

## Send a custom notification from the handler
<!-- teaches: ctx.mcpReq.notify({ method: 'acme/...', params }) for vendor-prefixed notifications -->
<!-- code: await ctx.mcpReq.notify({ method: 'acme/searchProgress', params: { stage: 'start', pct: 0 } }) -->

## Receive it on the client
<!-- teaches: setNotificationHandler('acme/...', { params }, handler) — same schema rule as requests -->
<!-- code: client.setNotificationHandler('acme/searchProgress', { params: SearchProgressParams }, params => ...) -->

## Declare an extension capability
<!-- teaches: registerCapabilities({ extensions: { 'com.example/x': {...} } }) before connecting; prefix-qualified identifiers | salvage: docs/server.md "Extension capabilities"; examples/extension-capabilities/server.ts -->
<!-- code: mcp.server.registerCapabilities({ extensions: { 'com.example/feature-flags': { flags: ['dark-mode'] } } }) -->

## Read the negotiated extensions on the client
<!-- teaches: getServerCapabilities()?.extensions — advertised by initialize on legacy connections and server/discover on 2026-07-28 ones (one-line era cross-link) | salvage: docs/client.md "Extension capabilities" -->
<!-- code: const extensions = client.getServerCapabilities()?.extensions ?? {} -->

## Recap
<!-- the claims this page will prove:
* Non-spec methods take a { params, result } schema bundle; spec methods never do.
* client.request(request, ResultSchema) is the calling side; both directions are validated.
* Custom notifications mirror custom requests: notify on one side, setNotificationHandler with { params } on the other.
* capabilities.extensions advertises a vendor feature; the client reads the negotiated map after connect.
* Method names and extension identifiers are prefix-qualified — never bare words.
-->
