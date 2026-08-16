---
shape: how-to
---
# Prompts

A **prompt** is a message template a connected client invokes by name. Clients surface prompts directly to people — slash commands, menu entries — where [tools](./tools.md) are picked by the model.

## Register a prompt

`registerPrompt` takes a name, a config, and a callback that returns the messages. `argsSchema` is a Zod object schema describing the arguments.

```ts source="../../examples/guides/servers/prompts.examples.ts#registerPrompt_review"
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const server = new McpServer({ name: 'review', version: '1.0.0' });

server.registerPrompt(
    'review-code',
    {
        title: 'Code Review',
        description: 'Review code for best practices and potential issues',
        argsSchema: z.object({
            code: z.string().describe('The code to review')
        })
    },
    ({ code }) => ({
        messages: [
            {
                role: 'user' as const,
                content: { type: 'text' as const, text: `Review this code:\n\n${code}` }
            }
        ]
    })
);
```

`prompts/list` now advertises `review-code` with one required argument, `code`.

::: tip
`.describe()` survives the conversion: `prompts/list` carries `The code to review` as the `code` argument's `description` — what a client shows next to the input field.
:::

::: info Coming from v1?
`registerPrompt` replaces `prompt()` — run the codemod, then see the [upgrade guide](../migration/upgrade-to-v2.md).
:::

Every call on this page comes from an in-memory `Client` connected to the server above — [Test a server](../testing.md) shows that wiring — and an MCP host does the same when someone picks the prompt. Fetch it with `getPrompt`.

```ts source="../../examples/guides/servers/prompts.examples.ts#getPrompt_review"
const result = await client.getPrompt({ name: 'review-code', arguments: { code: 'let x = 1' } });
console.log(result.messages);
```

The callback's messages come back with the argument filled in:

```
[
  {
    role: 'user',
    content: { type: 'text', text: 'Review this code:\n\nlet x = 1' }
  }
]
```

## Validate the arguments with the schema

Drop the required argument.

```ts source="../../examples/guides/servers/prompts.examples.ts#getPrompt_invalid"
import type { ProtocolError } from '@modelcontextprotocol/client';

try {
    await client.getPrompt({ name: 'review-code', arguments: {} });
} catch (error) {
    const { code, message } = error as ProtocolError;
    console.log(code, message);
}
```

The SDK rejects the request before your callback runs:

```
-32602 Invalid arguments for prompt review-code: code: Invalid input: expected string, received undefined
```

A failed prompt validation is a protocol error — `getPrompt` rejects with a `ProtocolError` carrying code `-32602` (Invalid params). A [tool](./tools.md) argument rejection comes back as an `isError: true` result instead.

From that one schema the SDK derives the argument list `prompts/list` advertises, validates `prompts/get` arguments before your callback runs, and infers the callback's argument types.

## Build the messages

The callback returns `{ messages }`. Each message names a `role` — `'user'` or `'assistant'` — and one `content` block; add an `assistant` message after the `user` message to seed how the reply starts.

```ts source="../../examples/guides/servers/prompts.examples.ts#registerPrompt_messages"
server.registerPrompt(
    'explain-error',
    {
        description: 'Explain a compiler error and suggest the smallest fix',
        argsSchema: z.object({ error: z.string() })
    },
    ({ error }) => ({
        messages: [
            {
                role: 'user' as const,
                content: { type: 'text' as const, text: `Explain this compiler error:\n\n${error}` }
            },
            {
                role: 'assistant' as const,
                content: { type: 'text' as const, text: 'The one-line cause:' }
            }
        ]
    })
);
```

The host hands the messages to the model in order, so the trailing `assistant` message becomes the start of its reply. `content` accepts the same union a tool result does: `text`, `image`, `audio`, `resource_link`, and `resource`.

## Embed a resource in a message

`type: 'resource'` puts a resource's contents inside a message. Register the resource as usual — see [Resources](./resources.md) — and embed the same `uri`, `mimeType`, and `text` in the prompt.

```ts source="../../examples/guides/servers/prompts.examples.ts#registerPrompt_embedResource"
const styleGuide = '- Prefer const over let.\n- No single-letter identifiers.';

server.registerResource('style-guide', 'doc://style-guide', { mimeType: 'text/markdown' }, async uri => ({
    contents: [{ uri: uri.href, mimeType: 'text/markdown', text: styleGuide }]
}));

server.registerPrompt(
    'review-against-style',
    {
        description: 'Review code against the team style guide',
        argsSchema: z.object({ code: z.string() })
    },
    ({ code }) => ({
        messages: [
            {
                role: 'user' as const,
                content: {
                    type: 'resource' as const,
                    resource: { uri: 'doc://style-guide', mimeType: 'text/markdown', text: styleGuide }
                }
            },
            {
                role: 'user' as const,
                content: { type: 'text' as const, text: `Review this code against the style guide:\n\n${code}` }
            }
        ]
    })
);
```

`prompts/get` returns the style guide inline as the first message, so the client never makes a second `resources/read` round trip:

```
{
  role: 'user',
  content: {
    type: 'resource',
    resource: {
      uri: 'doc://style-guide',
      mimeType: 'text/markdown',
      text: '- Prefer const over let.\n- No single-letter identifiers.'
    }
  }
}
```

The `uri` tells the client which registered resource the embedded copy came from.

## Offer argument autocompletion

Wrap an argument with `completable()` to suggest values while a client fills in the form.

```ts source="../../examples/guides/servers/prompts.examples.ts#registerPrompt_completable"
import { completable } from '@modelcontextprotocol/server';

server.registerPrompt(
    'translate',
    {
        description: 'Translate a snippet into another language',
        argsSchema: z.object({
            language: completable(z.string(), value =>
                ['typescript', 'python', 'rust', 'go'].filter(language => language.startsWith(value))
            ),
            code: z.string()
        })
    },
    ({ language, code }) => ({
        messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `Translate to ${language}:\n\n${code}` } }]
    })
);
```

The client sends `completion/complete` with the characters typed so far; the SDK runs your function and returns the matching values. [Completion](./completion.md) covers the request flow and context-aware suggestions.

## Recap

- `registerPrompt(name, config, callback)` registers a prompt; clients discover it through `prompts/list`.
- `argsSchema` is one Zod object: the advertised argument list, argument validation, and the callback's argument types.
- Arguments that fail the schema reject `prompts/get` with a `-32602` protocol error; the callback never runs.
- The callback returns `{ messages }`; each message names a `role` and one `content` block.
- A message can embed a registered resource's contents with `type: 'resource'`.
- `completable()` adds per-argument autocompletion.
