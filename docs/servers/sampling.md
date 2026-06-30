---
shape: how-to
---
# Sampling

::: warning Deprecated — SEP-2577
Call your LLM provider's API directly from your server instead. **Sampling** is deprecated as of protocol version 2026-07-28 (SEP-2577) and stays functional on 2025-era connections for at least twelve months — see the [deprecated features registry](https://modelcontextprotocol.io/specification/draft/deprecated).
:::

## Replace sampling with a direct provider call

Sampling routes an LLM call through the connected client: a tool handler sends a prompt, the host runs it through a model it controls, and the handler resumes with the completion. The 2026-07-28 revision removes the server-to-client request channel that carries it.

Migrate by importing your LLM provider's SDK into the server and calling it from the tool handler with your own API key. The handler keeps its shape; the `requestSampling` call is the only line that changes, and you stop depending on what the client supports.

## Request a completion from the client

`ctx.mcpReq.requestSampling` sends a `sampling/createMessage` request to the connected client from inside a tool handler. The client runs the messages through its model and resolves the call with the completion.

```ts source="../../examples/guides/servers/sampling.examples.ts#registerTool_sampling"
server.registerTool(
    'summarize',
    {
        description: 'Summarize text using the client LLM',
        inputSchema: z.object({ text: z.string() })
    },
    async ({ text }, ctx) => {
        const response = await ctx.mcpReq.requestSampling({
            messages: [{ role: 'user', content: { type: 'text', text: `Summarize in one sentence:\n\n${text}` } }],
            maxTokens: 500
        });
        return { content: [{ type: 'text', text: `Model (${response.model}): ${JSON.stringify(response.content)}` }] };
    }
);
```

The handler blocks until the client answers, so your server never holds the key for the model that does the work — the host does.

::: info
On a 2026-07-28 connection `requestSampling` throws. The replacement on that revision is returning an embedded `createMessage` request from the handler — [input_required](./input-required.md) owns that form. Era differences are listed in [Protocol versions](../protocol-versions.md).
:::

## Read the model's reply

The response is a `CreateMessageResult`: the client decides which model fulfils the request and returns its name as `model`, plus the assistant `role` and one `content` block. The handler above folds it into its tool result, so calling `summarize` from a client whose model is named `host-model` returns:

```
[
  {
    type: 'text',
    text: 'Model (host-model): {"type":"text","text":"Sampling lets a tool ask the client for a completion."}'
  }
]
```

## Require the sampling capability

`requestSampling` only works against a client that declared the `sampling` capability and registered a `sampling/createMessage` handler — [Handle requests from the server](../clients/server-requests.md) covers that side.

Pass `enforceStrictCapabilities: true` to the `McpServer` constructor and the SDK checks the client's declared capabilities before it sends any server-initiated request. Against a client that never declared `sampling`, `requestSampling` then throws inside your handler, and the call comes back as an ordinary `isError` tool result:

```
{
  content: [
    {
      type: 'text',
      text: 'Client does not support sampling (required for sampling/createMessage)'
    }
  ],
  isError: true
}
```

## Recap

- Sampling is deprecated (SEP-2577); the migration target is a direct LLM provider call from your server.
- `ctx.mcpReq.requestSampling({ messages, maxTokens })` asks the connected client's model for a completion mid-handler.
- The client picks the model; the result carries `model`, `role`, and `content`.
- On a 2026-07-28 connection `requestSampling` throws; the embedded-request form lives on the input_required page.
- The client must declare the `sampling` capability; `enforceStrictCapabilities: true` rejects the request before the wire when it did not.
