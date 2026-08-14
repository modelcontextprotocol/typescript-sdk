---
shape: how-to
---
# Call tools, read resources, get prompts

Every block on this page runs on a connected `Client` — [Connect to a server](./connect.md) shows the wiring — here paired in memory with an `orders` server that registers three tools, a resource, and a prompt.

## List the tools and call one

`listTools` returns the tools the server advertises; `callTool` invokes one by name with a plain `arguments` object.

```ts source="../../examples/guides/clients/calling.examples.ts#listTools_callTool"
const { tools } = await client.listTools();
console.log(tools.map(tool => tool.name));

const result = await client.callTool({ name: 'lookup-order', arguments: { id: 'A-1041' } });
console.log(result.content);
```

`result.content` is the content array the tool handler returned, unchanged:

```
[ 'lookup-order', 'order-total', 'export-orders' ]
[ { type: 'text', text: 'A-1041: 3 items, shipped' } ]
```

::: tip
A failed tool call is still a result: check `isError` on it before trusting `content`. Arguments the input schema rejects come back the same way. Only protocol-level failures — unknown tool, timeout — throw.
:::

## Let the SDK walk the pages

That `listTools()` already walked every page: when a server splits its list, the SDK follows `nextCursor` page by page and returns one aggregated list with no `nextCursor`. `listPrompts()`, `listResources()`, and `listResourceTemplates()` aggregate the same way.

Pass a `cursor` — a page's `nextCursor` your application held on to — and `listTools` returns exactly that page, raw.

```ts source="../../examples/guides/clients/calling.examples.ts#listTools_onePage"
const page = await client.listTools({ cursor: heldCursor });
console.log(
    page.tools.map(tool => tool.name),
    page.nextCursor
);
```

The `orders` server hands out its three tools two per page, and `heldCursor` names the second page — one tool, nothing left to follow:

```
[ 'export-orders' ] undefined
```

::: warning
`ClientOptions.listMaxPages` (default 64) caps the aggregate walk; a server whose pagination never terminates rejects the call with an `SdkError` whose code is `LIST_PAGINATION_EXCEEDED`. `listMaxPages: 0` removes the cap. Explicit-`cursor` calls are never capped.
:::

## Read structured output

A tool that declares an `outputSchema` returns `structuredContent` next to `content`. It is typed `unknown` — check that it is present and narrow it before use.

```ts source="../../examples/guides/clients/calling.examples.ts#callTool_structured"
const details = await client.callTool({ name: 'order-total', arguments: { id: 'A-1041' } });

const total: unknown = details.structuredContent;
if (typeof total === 'object' && total !== null && 'currency' in total) {
    console.log(total);
}
```

`order-total` declares `{ id, total, currency }`, and that is what comes back:

```
{ id: 'A-1041', total: 61.5, currency: 'EUR' }
```

When an earlier `listTools()` gave the client the tool's `outputSchema`, `callTool` validates `structuredContent` against it and rejects a result that does not match.

The wire encoding of structured results differs by protocol era — see [Protocol versions](../protocol-versions.md).

## Read a resource

`listResources` names what the server exposes; `readResource` fetches one URI.

```ts source="../../examples/guides/clients/calling.examples.ts#readResource_basic"
const { resources } = await client.listResources();
console.log(resources.map(resource => resource.uri));

const { contents } = await client.readResource({ uri: 'orders://recent' });
console.log(contents[0]);
```

Each item in `contents` carries the `uri`, a `mimeType`, and either `text` or a base64 `blob`:

```
[ 'orders://recent' ]
{
  uri: 'orders://recent',
  mimeType: 'application/json',
  text: '["A-1041","A-1042"]'
}
```

For parameterized URIs, `listResourceTemplates()` returns the server's URI templates — expand one and pass the resulting URI to `readResource`. To react when a resource changes instead of re-reading it on a timer, see [Subscriptions](./subscriptions.md).

## Get a prompt

`listPrompts` advertises each prompt with its arguments; `getPrompt` fills them in and returns `messages` ready to send to a model.

```ts source="../../examples/guides/clients/calling.examples.ts#getPrompt_basic"
const { prompts } = await client.listPrompts();
console.log(prompts.map(prompt => prompt.name));

const prompt = await client.getPrompt({ name: 'summarize-order', arguments: { id: 'A-1041', tone: 'terse' } });
console.log(prompt.messages);
```

The server's template comes back with both arguments substituted:

```
[ 'summarize-order' ]
[
  {
    role: 'user',
    content: {
      type: 'text',
      text: 'Write a terse status update for order A-1041.'
    }
  }
]
```

## Autocomplete an argument

`complete` asks the server for suggestions while the user types an argument: `ref` names the prompt (or resource template) and `argument` carries the partial value.

```ts source="../../examples/guides/clients/calling.examples.ts#complete_tone"
const { completion } = await client.complete({
    ref: { type: 'ref/prompt', name: 'summarize-order' },
    argument: { name: 'tone', value: 'f' }
});
console.log(completion.values);
```

The server matches `f` against the values it accepts for `tone`:

```
[ 'formal', 'friendly' ]
```

## Track progress on a long call

Every verb takes request options as a second argument. `onprogress` receives each `notifications/progress` the server emits for this call; `resetTimeoutOnProgress` restarts the request timeout on every update and `maxTotalTimeout` is the absolute cap.

```ts source="../../examples/guides/clients/calling.examples.ts#callTool_progress"
const exported = await client.callTool(
    { name: 'export-orders', arguments: { format: 'csv' } },
    {
        onprogress: update => console.log(update),
        resetTimeoutOnProgress: true,
        maxTotalTimeout: 600_000
    }
);
console.log(exported.content);
```

The updates stream in while the call is still pending; the return type does not change:

```
{ progress: 1, total: 2, message: 'exported A-1041' }
{ progress: 2, total: 2, message: 'exported A-1042' }
[ { type: 'text', text: '2 orders exported as csv' } ]
```

## Recap

- `listTools`, `listResources`, `listResourceTemplates`, and `listPrompts` aggregate every page; `{ cursor }` fetches a single raw page and `listMaxPages` caps the walk.
- `callTool` returns `content` for the model and, when the tool declares an `outputSchema`, `structuredContent` for your application.
- `readResource({ uri })` and `getPrompt({ name, arguments })` follow the same list-then-fetch shape as tools.
- `complete()` returns the server's suggestions for a prompt or resource-template argument.
- `onprogress` in the request options streams progress updates without changing the call's return type.
