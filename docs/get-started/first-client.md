---
shape: tutorial
---

# Build your first client

Build an MCP **client** — the program that launches a server, lists its tools, and calls them — against the weather server from [Build your first server](./first-server.md).

## Connect to a server

In the weather project, add the client package — it ships separately from `@modelcontextprotocol/server`.

```sh
npm install @modelcontextprotocol/client
```

Create `src/client.ts`. A `Client` plus one transport is a complete MCP client.

```ts source="../../examples/guides/get-started/firstClient.examples.ts#firstClient_connect"
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const client = new Client({ name: 'my-first-client', version: '1.0.0' });

const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'src/index.ts']
});

await client.connect(transport);
```

`connect()` spawns `npx tsx src/index.ts` as a child process, speaks JSON-RPC over its stdin and stdout, and completes the **initialize** handshake. The client owns that process from here: it lives exactly as long as the transport.

::: tip
Never start `src/index.ts` yourself — `connect()` does. A `spawn npx ENOENT` error here means `command` is not an executable on your `PATH`.
:::

stdio is the transport local hosts use; [Connect to a server](../clients/connect.md) covers HTTP for remote servers.

## List the server's tools

`listTools` returns every tool the server registered, with the JSON Schema it derived for each one's arguments.

```ts source="../../examples/guides/get-started/firstClient.examples.ts#firstClient_listTools"
const { tools } = await client.listTools();
for (const tool of tools) {
    console.log(tool.name, '—', tool.description);
}
```

Run what you have so far — `npx tsx src/client.ts` from the project root. The first line is the server's banner, forwarded from the child's stderr; the second is your loop.

```text
weather MCP server running on stdio
get-alerts — Get the active weather alerts for a US state
```

The script does not exit on its own — the client still owns a live server process. Stop it with `Ctrl+C` for now; [Close the connection](#close-the-connection) ends it properly.

## Call a tool

`callTool` takes the tool's name and an `arguments` object that must satisfy its `inputSchema`.

```ts source="../../examples/guides/get-started/firstClient.examples.ts#firstClient_callTool"
const result = await client.callTool({ name: 'get-alerts', arguments: { state: 'CA' } });

for (const block of result.content) {
    if (block.type === 'text') console.log(block.text);
}
```

A tool result is a list of typed **content** blocks; `get-alerts` returns one `text` block. Its text is the live answer from the National Weather Service — one headline per active California alert, or `No active alerts for CA.` when there are none — so your output differs from anyone else's.

A handler that throws, and arguments the `inputSchema` rejects, come back in this same shape with `isError: true` set. A tool name the server never registered is a protocol-level failure, and that one does throw out of `await callTool` — [Errors](../servers/errors.md) draws the line.

::: tip
Change the argument to `{ state: 'California' }` and the SDK rejects it before the handler (and the network request inside it) ever runs:

```text
Input validation error: Invalid arguments for tool get-alerts: state: Too big: expected string to have <=2 characters
```

The rejection is an ordinary `isError: true` result, so a model reads the message and retries with arguments that fit.
:::

## Add a resource and read it

The weather server registers no **resources** yet — a resource is data a client reads by URI, where a tool is an action it invokes. In `src/index.ts`, register one above the `return server` line.

```ts source="../../examples/guides/get-started/firstClient.examples.ts#firstClient_registerResource"
server.registerResource(
    'about',
    'weather://about',
    { title: 'About this server', mimeType: 'text/plain' },
    async uri => ({
        contents: [{ uri: uri.href, text: 'Alert data comes from the US National Weather Service.' }]
    })
);
```

The read handler returns `contents` — a list, because one read can return several text or binary parts. [Resources](../servers/resources.md) covers templates, binary contents, and subscriptions.

Back in `src/client.ts`, list the resources and read the new one by its `uri`.

```ts source="../../examples/guides/get-started/firstClient.examples.ts#firstClient_readResource"
const { resources } = await client.listResources();
console.log(resources);

const { contents } = await client.readResource({ uri: 'weather://about' });
console.log(contents);
```

Run it again. After the lines you already have, the two new logs are:

```
[
  {
    name: 'about',
    title: 'About this server',
    uri: 'weather://about',
    mimeType: 'text/plain'
  }
]
[
  {
    uri: 'weather://about',
    text: 'Alert data comes from the US National Weather Service.'
  }
]
```

`listResources` advertises the metadata you registered; `readResource` returns the handler's `contents` unchanged.

## Close the connection

End the file with `close`.

```ts source="../../examples/guides/get-started/firstClient.examples.ts#firstClient_close"
await client.close();
```

`close()` ends the spawned server's stdin and kills the process if it does not exit on its own. Run the finished script once more: it prints everything above and exits without `Ctrl+C`.

::: tip
In a client that can throw between `connect` and `close`, put `close()` in a `finally` block — otherwise a crash leaves the server process running.
:::

## Hand the tool list to a model

Nothing on this page calls a model. The handoff is `listTools()`: each entry's `name`, `description`, and `inputSchema` — plain JSON Schema — map one-to-one onto the tool definition every tool-calling LLM API takes. Send the conversation with that list; when the model returns a tool call, pass its `name` and `arguments` to `callTool` unchanged and append `result.content` as the tool result.

A host — an application with a model in it — runs that loop for you, through a client of its own. [Plug into a real host](./real-host.md) registers the weather server in VS Code, Claude Code, and Cursor with no client code; `examples/cli-client` in the SDK repository is a complete, provider-neutral host built from the calls on this page.

## Recap

- A `Client` plus one transport is a complete MCP client; `connect()` runs the initialize handshake.
- `StdioClientTransport` spawns and owns the server process — never start it yourself.
- `listTools`, `callTool`, `listResources`, and `readResource` are the client verbs; each returns a typed result.
- A failed handler or rejected arguments come back as an ordinary result with `isError: true` set.
- `close()` tears down the transport and the spawned process.
- A model consumes `listTools()` output unchanged: `name`, `description`, `inputSchema`.
