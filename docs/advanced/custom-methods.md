---
shape: how-to
---

# Custom methods

A **custom method** is a JSON-RPC method outside the MCP specification. Prefix it with a vendor namespace — `acme/search`, never a bare `search` — so it can never collide with a spec method.

## Handle a vendor-prefixed method on the server

`setRequestHandler` lives on the low-level [`Server`](./low-level-server.md), reached from an `McpServer` as `mcp.server`. A non-spec method needs schemas: pass `{ params, result }` as the second argument and the handler receives the parsed `params` object directly.

```ts source="../../examples/guides/advanced/custom-methods.examples.ts#setRequestHandler_custom"
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const SearchParams = z.object({ query: z.string(), limit: z.number().int().default(10) });
const SearchResult = z.object({ items: z.array(z.string()) });

const mcp = new McpServer({ name: 'acme-search', version: '1.0.0' });

mcp.server.setRequestHandler('acme/search', { params: SearchParams, result: SearchResult }, async ({ query, limit }) => {
    return { items: Array.from({ length: limit }, (_, index) => `${query}-${index}`) };
});
```

The SDK validates incoming `params` against `SearchParams` before the handler runs; `result` types the handler's return value. A spec method never takes the schema bundle — `setRequestHandler('tools/call', handler)` resolves its schemas from the method name.

::: tip
Send `acme/search` with `query: 42` and the request fails before your handler runs — the caller gets back an `Invalid params` JSON-RPC error:

```
Invalid params for acme/search: query: Invalid input: expected string, received number
```

:::

## Call it from the client

Every call on this page comes from an in-memory `Client` connected to the server above — [Test a server](../testing.md) shows that wiring. For a non-spec method, `client.request` takes the request and a result schema; the SDK validates the response against it before the promise resolves and infers the return type from it.

```ts source="../../examples/guides/advanced/custom-methods.examples.ts#request_custom"
const result = await client.request({ method: 'acme/search', params: { query: 'mcp', limit: 3 } }, SearchResult);
console.log(result);
```

The handler's return value comes back validated and typed:

```
{ items: [ 'mcp-0', 'mcp-1', 'mcp-2' ] }
```

::: info
For spec methods, `client.request({ method: 'tools/list' })` takes no schema — the SDK resolves it from the method name, exactly as `setRequestHandler` does on the server.
:::

## Send a custom notification from the handler

A custom **notification** is the one-way mirror of a custom request: vendor-prefixed, no result. Registering a method again replaces its handler — replace `acme/search` with one that reports progress through `ctx.mcpReq.notify`.

```ts source="../../examples/guides/advanced/custom-methods.examples.ts#setRequestHandler_notify"
mcp.server.setRequestHandler('acme/search', { params: SearchParams, result: SearchResult }, async ({ query, limit }, ctx) => {
    await ctx.mcpReq.notify({ method: 'acme/searchProgress', params: { stage: 'start', pct: 0 } });
    const items = Array.from({ length: limit }, (_, index) => `${query}-${index}`);
    await ctx.mcpReq.notify({ method: 'acme/searchProgress', params: { stage: 'done', pct: 1 } });
    return { items };
});
```

`ctx.mcpReq.notify` sends each notification to the peer whose request is being handled, on the same connection.

## Receive it on the client

`setNotificationHandler` follows the same rule as `setRequestHandler`: a non-spec notification method takes a `{ params }` schema, and the handler receives the parsed params.

```ts source="../../examples/guides/advanced/custom-methods.examples.ts#setNotificationHandler_custom"
const SearchProgressParams = z.object({ stage: z.string(), pct: z.number() });

client.setNotificationHandler('acme/searchProgress', { params: SearchProgressParams }, params => {
    console.log(params);
});

await client.request({ method: 'acme/search', params: { query: 'mcp', limit: 1 } }, SearchResult);
```

That one call logs both stages:

```
{ stage: 'start', pct: 0 }
{ stage: 'done', pct: 1 }
```

## Declare an extension capability

An **extension capability** advertises a vendor feature during capability negotiation: `capabilities.extensions` maps a prefix-qualified extension identifier to that extension's settings object. Declare entries with `registerCapabilities` before connecting.

```ts source="../../examples/guides/advanced/custom-methods.examples.ts#registerCapabilities_extensions"
mcp.server.registerCapabilities({
    extensions: { 'com.example/feature-flags': { flags: ['dark-mode', 'beta-search'] } }
});
```

Every client that connects sees the entry. The settings value is free-form JSON; `{}` means supported with no settings.

## Read the negotiated extensions on the client

After connecting, the advertised map is on `client.getServerCapabilities()`.

```ts source="../../examples/guides/advanced/custom-methods.examples.ts#getServerCapabilities_extensions"
const extensions = client.getServerCapabilities()?.extensions ?? {};
console.log(extensions);
```

The map arrives exactly as the server declared it:

```
{
  'com.example/feature-flags': { flags: [ 'dark-mode', 'beta-search' ] }
}
```

Legacy connections advertise it in the `initialize` result and 2026-07-28 connections in `server/discover` — see [Protocol versions](../protocol-versions.md).

## Recap

- `setRequestHandler(method, { params, result }, handler)` handles a non-spec method; spec methods never take the schema bundle.
- The SDK validates incoming `params` before the handler runs and rejects what fails with an `Invalid params` error; `result` types the handler's return value.
- `client.request(request, ResultSchema)` is the calling side; the SDK validates the response against the schema.
- Custom notifications mirror custom requests: `ctx.mcpReq.notify` on one side, `setNotificationHandler` with `{ params }` on the other.
- `capabilities.extensions` advertises a vendor feature before connecting; the client reads the negotiated map after.
- Method names and extension identifiers are prefix-qualified (`acme/search`, `com.example/feature-flags`) — never bare words.
