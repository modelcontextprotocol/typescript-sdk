---
shape: how-to
---
# Elicitation

A tool handler asks the end user a question mid-call with `ctx.mcpReq.elicitInput` — the connected client puts the question in front of them and the promise resolves with their answer.

## Ask for input with a form

**Form mode** carries a `message` and a `requestedSchema`: a flat JSON Schema of primitive fields the client renders as a form.

```ts source="../../examples/guides/servers/elicitation.examples.ts#registerTool_elicitForm"
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const server = new McpServer({ name: 'feedback', version: '1.0.0' });

server.registerTool(
    'collect-feedback',
    {
        description: 'Ask the user how something went',
        inputSchema: z.object({ topic: z.string() })
    },
    async ({ topic }, ctx) => {
        const result = await ctx.mcpReq.elicitInput({
            mode: 'form',
            message: `How was ${topic}?`,
            requestedSchema: {
                type: 'object',
                properties: {
                    rating: { type: 'number', title: 'Rating (1-5)', minimum: 1, maximum: 5 },
                    comment: { type: 'string', title: 'Comment' }
                },
                required: ['rating']
            }
        });
        if (result.action !== 'accept') {
            return { content: [{ type: 'text', text: `Feedback ${result.action}.` }] };
        }
        return { content: [{ type: 'text', text: `Recorded: ${JSON.stringify(result.content)}` }] };
    }
);
```

`result.action` records what the end user did — `accept`, `decline`, or `cancel` — and `result.content` carries the submitted fields on accept only. The SDK validates accepted content against `requestedSchema` before `elicitInput` resolves, so the fields you read match the schema you sent.

::: info
On a 2026-07-28 connection `elicitInput` throws — a handler returns the request instead; see [Input required](./input-required.md) and [Protocol versions](../protocol-versions.md).
:::

The answer comes from the connected client's `elicitation/create` handler. Every call on this page uses an in-memory client whose handler stands in for a real host's UI — [Handle requests from the server](../clients/server-requests.md) covers the client side in full.

```ts source="../../examples/guides/servers/elicitation.examples.ts#Client_elicitationHandler"
const client = new Client({ name: 'feedback-host', version: '1.0.0' }, { capabilities: { elicitation: { form: {}, url: {} } } });

client.setRequestHandler('elicitation/create', async request => {
    if (request.params.mode === 'url') {
        // Open request.params.url in the user's browser; answer when they finish.
        return { action: 'accept' };
    }
    // Render request.params.requestedSchema as a form; return what the user typed.
    return { action: 'accept', content: { rating: 5, comment: 'Smooth setup' } };
});
```

Call `collect-feedback` and the elicitation round-trips through that handler inside the one tool call.

```ts source="../../examples/guides/servers/elicitation.examples.ts#callTool_collectFeedback"
const result = await client.callTool({ name: 'collect-feedback', arguments: { topic: 'the new editor' } });
console.log(result.content);
```

The handler resumes with the submitted fields and returns:

```
[
  {
    type: 'text',
    text: 'Recorded: {"rating":5,"comment":"Smooth setup"}'
  }
]
```

## Handle every action

Return a distinct result for each `action` so the model knows whether the end user confirmed, refused, or never answered.

```ts source="../../examples/guides/servers/elicitation.examples.ts#registerTool_elicitActions"
server.registerTool(
    'delete-dataset',
    {
        description: 'Delete a dataset after the user confirms',
        inputSchema: z.object({ name: z.string() })
    },
    async ({ name }, ctx) => {
        const result = await ctx.mcpReq.elicitInput({
            mode: 'form',
            message: `Delete ${name}? This cannot be undone.`,
            requestedSchema: {
                type: 'object',
                properties: { confirm: { type: 'boolean', title: 'Yes, delete it' } },
                required: ['confirm']
            }
        });
        switch (result.action) {
            case 'accept':
                if (result.content?.confirm !== true) {
                    return { content: [{ type: 'text', text: 'Box left unchecked - nothing deleted.' }] };
                }
                return { content: [{ type: 'text', text: `Deleted ${name}.` }] };
            case 'decline':
                return { content: [{ type: 'text', text: 'Declined - nothing deleted.' }] };
            case 'cancel':
                return { content: [{ type: 'text', text: 'Dismissed - ask again later.' }] };
        }
    }
);
```

`result.content` is end-user input: schema-valid, still untrusted — the `accept` branch checks that the box was actually ticked before acting. Decline the form and the tool answers from the `decline` branch:

```
[ { type: 'text', text: 'Declined - nothing deleted.' } ]
```

## Send the end user to a URL

**URL mode** replaces the form with a browser flow: pass `url` and a unique `elicitationId` instead of `requestedSchema`.

```ts source="../../examples/guides/servers/elicitation.examples.ts#registerTool_elicitUrl"
server.registerTool(
    'link-account',
    {
        description: 'Link a billing account through a hosted sign-in flow',
        inputSchema: z.object({ provider: z.string() })
    },
    async ({ provider }, ctx) => {
        const result = await ctx.mcpReq.elicitInput({
            mode: 'url',
            message: `Sign in to ${provider} to link your account`,
            url: `https://billing.example.com/connect/${encodeURIComponent(provider)}`,
            elicitationId: crypto.randomUUID()
        });
        if (result.action !== 'accept') {
            return { content: [{ type: 'text', text: `Sign-in ${result.action}.` }] };
        }
        return { content: [{ type: 'text', text: `Linked ${provider}.` }] };
    }
);
```

The client opens the URL and answers once the end user finishes there; whatever the page collects — credentials, payment details, API keys — stays in the browser and never crosses the MCP connection. The handler's `url` branch above accepts, so `link-account` returns:

```
[ { type: 'text', text: 'Linked github.' } ]
```

## Keep secrets out of forms

Form answers travel back through the client and land in the model's context like any other tool result.

::: warning
Never collect sensitive information — passwords, API keys, payment details — through form elicitation. Use URL mode or an out-of-band flow instead.
:::

## Require the elicitation capability

Elicitation only works against a client that declared the `elicitation` capability — per mode: `form`, `url` — when it connected. Against a client without it, `elicitInput` throws before anything reaches the wire, and the thrown message comes back as an ordinary `isError` tool result:

```
{
  content: [
    { type: 'text', text: 'Client does not support form elicitation.' }
  ],
  isError: true
}
```

## Recap

- `ctx.mcpReq.elicitInput` sends an `elicitation/create` request mid-handler and resolves with the end user's answer.
- Form mode carries a `message` and a flat JSON-Schema `requestedSchema`; the SDK validates accepted content against it.
- `result.action` is `accept`, `decline`, or `cancel`; `result.content` is present only on accept.
- URL mode hands the end user a browser flow — use it for anything sensitive.
- Calls against a client that never declared the `elicitation` capability fail before reaching the wire.
