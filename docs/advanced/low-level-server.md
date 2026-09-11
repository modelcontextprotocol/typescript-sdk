---
shape: explanation
---

# Low-level Server

`Server` is the **protocol layer** under `McpServer`: it routes each JSON-RPC request to the handler you register for that method string, and nothing more. Rebuild the `search` tool from [Tools](../servers/tools.md) on it to see what `registerTool` adds.

## Build the server and list your tools by hand

Declare the `tools` capability in the constructor and answer `tools/list` yourself. `inputSchema` is the raw JSON Schema the client and the model see.

```ts source="../../examples/guides/advanced/low-level-server.examples.ts#lowLevel_listTools"
import { Server } from '@modelcontextprotocol/server';

const catalog = [
    { name: 'Espresso cup', price: 12 },
    { name: 'Travel mug', price: 24 },
    { name: 'Mug rack', price: 36 }
];

const server = new Server({ name: 'catalog', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler('tools/list', async () => ({
    tools: [
        {
            name: 'search',
            description: 'Search the product catalog',
            inputSchema: {
                type: 'object',
                properties: { query: { type: 'string', description: 'Substring to match against product names' } },
                required: ['query']
            }
        }
    ]
}));
```

A client's `tools/list` returns exactly the array you wrote — the SDK derived none of it.

::: tip
Drop `capabilities: { tools: {} }` and `setRequestHandler('tools/list', …)` throws. `Server` never infers a capability from a handler, the way `registerTool` registers the `tools` capability for you.
:::

## Handle `tools/call` yourself

`tools/call` is one handler for every tool. Dispatch on `request.params.name` and read `request.params.arguments` yourself.

```ts source="../../examples/guides/advanced/low-level-server.examples.ts#lowLevel_callTool"
server.setRequestHandler('tools/call', async request => {
    if (request.params.name !== 'search') {
        return { content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }], isError: true };
    }
    const { query } = request.params.arguments as { query: string };
    const hits = catalog.filter(product => product.name.toLowerCase().includes(query.toLowerCase()));
    return { content: [{ type: 'text', text: hits.map(product => product.name).join('\n') }] };
});
```

An in-memory `Client` connected to this server — [Test a server](../testing.md) shows that wiring — calls `search` with `{ query: 'mug' }` and the handler's `content` comes back unchanged:

```
[ { type: 'text', text: 'Travel mug\nMug rack' } ]
```

Now call it with `{ query: 42 }`. The protocol layer checks only that `arguments` is an object, so the value reaches the handler and the handler crashes:

```
ProtocolError -32603: query.toLowerCase is not a function
```

`callTool` rejected with a protocol error instead of resolving to an `isError: true` tool result — [Errors](../servers/errors.md) covers the difference.

## Validate arguments yourself

From one Zod `inputSchema` the SDK derives the JSON Schema the model sees, validates arguments before your handler runs, and infers the handler's argument types. Here you wrote the JSON Schema by hand, the cast went unchecked, and nothing tied the two together.

`fromJsonSchema` — exported from `@modelcontextprotocol/server` — wraps a JSON Schema object as a validator you run yourself. Registering `tools/call` again replaces the handler; this one rejects before it touches the arguments.

```ts source="../../examples/guides/advanced/low-level-server.examples.ts#lowLevel_validate"
const SearchArguments = fromJsonSchema<{ query: string }>({
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query']
});

server.setRequestHandler('tools/call', async request => {
    if (request.params.name !== 'search') {
        return { content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }], isError: true };
    }
    const parsed = await SearchArguments['~standard'].validate(request.params.arguments ?? {});
    if (parsed.issues) {
        return { content: [{ type: 'text', text: parsed.issues.map(issue => issue.message).join('; ') }], isError: true };
    }
    const hits = catalog.filter(product => product.name.toLowerCase().includes(parsed.value.query.toLowerCase()));
    return { content: [{ type: 'text', text: hits.map(product => product.name).join('\n') }] };
});
```

The same `{ query: 42 }` call now comes back as an ordinary tool result the model can read and retry:

```
{
  content: [ { type: 'text', text: 'data/query must be string' } ],
  isError: true
}
```

Keeping the schema you advertise in `tools/list` identical to the one you validate with is still on you — `registerTool` derives both from the same object.

## Serve it with the same entry points

`serveStdio` — from `@modelcontextprotocol/server/stdio` — and `createMcpHandler` each take an `McpServerFactory`, and the factory returns either an `McpServer` or a `Server`.

```ts source="../../examples/guides/advanced/low-level-server.examples.ts#lowLevel_serve"
serveStdio(() => server);
createMcpHandler(() => server);
```

Every serving recipe — [stdio](../serving/stdio.md), [HTTP](../serving/http.md) — applies to this server unchanged.

## Reach the low level from `McpServer`

Every `McpServer` owns its `Server` as `mcp.server`, so drop down per method, never per program. Declare the extra capability in the constructor, keep `registerTool` for the tools, and hand-register the method you want to answer yourself.

```ts source="../../examples/guides/advanced/low-level-server.examples.ts#lowLevel_escapeHatch"
const mcp = new McpServer({ name: 'catalog', version: '1.0.0' }, { capabilities: { resources: { subscribe: true } } });

mcp.registerTool(
    'search',
    { description: 'Search the product catalog', inputSchema: z.object({ query: z.string() }) },
    async ({ query }) => {
        const names = catalog.filter(product => product.name.includes(query)).map(product => product.name);
        return { content: [{ type: 'text', text: names.join('\n') }] };
    }
);

const subscriptions = new Set<string>();
mcp.server.setRequestHandler('resources/subscribe', async request => {
    subscriptions.add(request.params.uri);
    return {};
});
```

`registerTool` still answers `tools/list` and `tools/call`; `resources/subscribe` reaches the handler you wrote. On the 2026-07-28 revision resource subscriptions arrive on a `subscriptions/listen` stream the serving entries answer for you — see [Protocol versions](../protocol-versions.md).

::: info
Per-resource subscriptions specifically no longer need this escape hatch: declaring `resources: { subscribe: true }` alone makes the SDK install both subscription verbs at connect time and own the subscribed-URI set, and `trackResourceSubscriptions()` adds veto hooks — see [Resources](../servers/resources.md#serve-per-resource-subscriptions). Hand-registered handlers like the one above still win: the automatic install skips when either verb already has a handler. The mechanics shown here stay the same for any method you take over.
:::

## Decide which layer to build on

Default to `McpServer`. `registerTool`, `registerResource`, and `registerPrompt` cover everything this page rebuilt — schema derivation, argument validation, typed handler arguments — plus the bookkeeping it skipped: `listChanged` notifications, [completions](../servers/completion.md), and the list/read/get dispatch for every registry.

Build on `Server` when you own dispatch: a [gateway](./gateway.md) that forwards whatever method arrives, a tool set computed per request from an external registry, or [custom methods](./custom-methods.md) outside the spec.

You never choose once for the whole program. Start on `McpServer` and take over individual methods through `mcp.server` as they need it.

## Recap

- `Server` is the protocol layer: `setRequestHandler(method, handler)` per spec method, and nothing derived on top.
- On `Server` you write the JSON Schema in `tools/list` and the argument validation in `tools/call`; `registerTool` derives both from one Zod schema.
- A handler exception on `Server` reaches the client as a protocol error, not as an `isError: true` tool result.
- `serveStdio` and `createMcpHandler` accept a factory that returns a `Server` unchanged.
- `mcp.server` is the per-method escape hatch; default to `McpServer` and drop to `Server` only where you own dispatch.
