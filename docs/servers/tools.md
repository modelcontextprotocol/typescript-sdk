---
status: calibration
shape: how-to
---

# Tools

A **tool** is an action a connected client — and the model driving it — can invoke on your server.

## Add a tool

`registerTool` takes a name, a config, and a handler. `inputSchema` is a Zod schema — the only schema you write.

```ts source="../../examples/guides/servers/tools.examples.ts#registerTool_search"
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const catalog = [
    { name: 'Espresso cup', price: 12 },
    { name: 'Travel mug', price: 24 },
    { name: 'Mug rack', price: 36 }
];

const server = new McpServer({ name: 'catalog', version: '1.0.0' });

server.registerTool(
    'search',
    {
        description: 'Search the product catalog',
        inputSchema: z.object({
            query: z.string().describe('Substring to match against product names'),
            limit: z.number().int().max(50).optional()
        })
    },
    async ({ query, limit }) => {
        const hits = catalog.filter(product => product.name.toLowerCase().includes(query.toLowerCase()));
        const names = hits.slice(0, limit ?? 10).map(product => product.name);
        return { content: [{ type: 'text', text: names.join('\n') }] };
    }
);
```

From that one schema the SDK derives the JSON Schema the model sees, validates arguments before your handler runs, and infers the handler's argument types.

`tools/list` now advertises `search`, and the SDK has already parsed every call that reaches your handler.

::: tip
`.describe()` survives the conversion: the JSON Schema advertised for `query` carries `Substring to match against product names` as its `description` — the only documentation the model gets for that argument.
:::

::: info Coming from v1?
`registerTool` replaces `tool()` — run the codemod, then see the [upgrade guide](../migration/upgrade-to-v2.md).
:::

## Call it

Every call on this page comes from an in-memory `Client` connected to the server above — [Test a server](../testing.md) shows that wiring — and an MCP host does the same over stdio or HTTP. Call the tool with valid arguments.

```ts source="../../examples/guides/servers/tools.examples.ts#callTool_search"
const result = await client.callTool({ name: 'search', arguments: { query: 'mug' } });
console.log(result.content);
```

The handler's `content` comes back unchanged:

```
[ { type: 'text', text: 'Travel mug\nMug rack' } ]
```

## Send arguments the schema rejects

Change one argument: a `limit` the schema caps at 50.

```ts source="../../examples/guides/servers/tools.examples.ts#callTool_invalid"
const rejected = await client.callTool({ name: 'search', arguments: { query: 'mug', limit: 999 } });
console.log(rejected);
```

The SDK rejects the arguments before your handler runs:

```
{
  content: [
    {
      type: 'text',
      text: 'Input validation error: Invalid arguments for tool search: limit: Too big: expected number to be <=50'
    }
  ],
  isError: true
}
```

The rejection is an ordinary tool result with `isError: true`, so the model reads the message and retries with arguments that fit the schema. Thrown errors and protocol-level failures are their own topic — see [Errors](errors.md).

## Return structured output

Add `outputSchema` and return the matching value as `structuredContent`, next to the human-readable `content`.

```ts source="../../examples/guides/servers/tools.examples.ts#registerTool_structured"
server.registerTool(
    'product-details',
    {
        description: 'Look up one product by its exact name',
        inputSchema: z.object({ name: z.string() }),
        outputSchema: z.object({ name: z.string(), price: z.number() })
    },
    async ({ name }) => {
        const product = catalog.find(candidate => candidate.name === name);
        if (!product) throw new Error(`No product named ${name}`);
        const output = { name: product.name, price: product.price };
        return {
            content: [{ type: 'text', text: JSON.stringify(output) }],
            structuredContent: output
        };
    }
);
```

The SDK validates `structuredContent` against `outputSchema` before the result leaves your server, and advertises the derived JSON Schema in `tools/list` so clients can validate it too.

Calling `product-details` with `{ name: 'Travel mug' }` returns both renderings:

```
{
  content: [ { type: 'text', text: '{"name":"Travel mug","price":24}' } ],
  structuredContent: { name: 'Travel mug', price: 24 }
}
```

The wire encoding of structured results differs by protocol era — see [Protocol versions](../protocol-versions.md).

## Return other content types

One result can mix content blocks: `image` and `audio` carry base64 `data` with a `mimeType`; `resource` embeds a resource's contents inline; `resource_link` names a resource by `uri` without its bytes.

```ts source="../../examples/guides/servers/tools.examples.ts#registerTool_contentTypes"
// Base64 payloads; read yours from disk: readFileSync('card.png').toString('base64')
const cardPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const spokenNameWav = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

server.registerTool(
    'product-card',
    {
        description: 'Render one product as an image, a spoken name, and its catalog record',
        inputSchema: z.object({ name: z.string() })
    },
    async ({ name }) => {
        const product = catalog.find(candidate => candidate.name === name);
        if (!product) throw new Error(`No product named ${name}`);
        return {
            content: [
                { type: 'image', data: cardPng, mimeType: 'image/png' },
                { type: 'audio', data: spokenNameWav, mimeType: 'audio/wav' },
                {
                    type: 'resource',
                    resource: {
                        uri: `catalog://products/${encodeURIComponent(product.name)}`,
                        mimeType: 'application/json',
                        text: JSON.stringify(product)
                    }
                }
            ]
        };
    }
);
```

Calling `product-card` with `{ name: 'Travel mug' }` returns the three blocks as written:

```
[
  {
    type: 'image',
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    mimeType: 'image/png'
  },
  {
    type: 'audio',
    data: 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=',
    mimeType: 'audio/wav'
  },
  {
    type: 'resource',
    resource: {
      uri: 'catalog://products/Travel%20mug',
      mimeType: 'application/json',
      text: '{"name":"Travel mug","price":24}'
    }
  }
]
```

The blocks reach the client exactly as returned, and the embedded `resource` arrives without a `resources/read` round trip.

## Annotate the tool

`title` is the display name; `annotations` are behavior hints for the client.

```ts source="../../examples/guides/servers/tools.examples.ts#registerTool_annotations"
server.registerTool(
    'clear-catalog',
    {
        title: 'Clear the catalog',
        description: 'Remove every product from the catalog',
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    },
    async () => {
        catalog.length = 0;
        return { content: [{ type: 'text', text: 'Catalog cleared' }] };
    }
);
```

A tool that takes no arguments omits `inputSchema`. Annotations never change how the SDK runs the tool — clients use them to decide what to put in front of the end user: a host can auto-approve a read-only tool and require confirmation before a destructive one.

## Recap

- `registerTool(name, config, handler)` registers a tool; `inputSchema` is a Zod object schema.
- The one schema yields the advertised JSON Schema, argument validation, and the handler's argument types.
- Arguments that fail the schema come back as an `isError: true` tool result; the handler never runs.
- `outputSchema` plus `structuredContent` add machine-readable results, validated before they leave the server.
- `content` blocks are `text`, `image`, `audio`, `resource_link`, or an embedded `resource`; one result can mix them.
- `title` and `annotations` describe the tool to clients and never change execution.
