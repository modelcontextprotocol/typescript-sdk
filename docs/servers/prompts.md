---
status: scaffold
shape: how-to
---
# Prompts

<!-- SCAFFOLD - structure only; prose comes in a later tranche.
scope: Register prompts, message construction.
teaches: McpServer.registerPrompt, PromptCallback, argsSchema
source: mined from docs/server.md "Prompts"
-->

## Register a prompt
<!-- teaches: registerPrompt(name, config, cb) | salvage: docs/server.md "Prompts" (registerPrompt_basic) -->

```ts
// draft - API verified against packages/server/src/server/mcp.ts (registerPrompt, line 1031)
server.registerPrompt(
  'review-code',
  {
    title: 'Code Review',
    description: 'Review code for best practices and potential issues',
    argsSchema: z.object({
      code: z.string(),
    }),
  },
  ({ code }) => ({
    messages: [
      {
        role: 'user' as const,
        content: { type: 'text' as const, text: `Please review this code:\n\n${code}` },
      },
    ],
  })
);
```
<!-- result: the prompt appears in prompts/list; prompts/get returns the messages with the argument filled in. -->

## Validate the arguments with the schema
<!-- teaches: argsSchema is a Zod object; the SDK validates prompts/get arguments before the callback and infers the callback's argument types -->
<!-- code: prompts/get with a missing `code` argument -->
<!-- result: the verbatim -32602 Invalid Params error the client receives -->
<!-- the schema-payoff sentence lands here, once -->

## Build the messages
<!-- teaches: PromptMessage shape - role ('user' | 'assistant') and content item types | salvage: docs/server.md "Prompts" -->
<!-- code: a two-message prompt (user + assistant) showing the role/content structure -->

## Embed a resource in a message
<!-- teaches: content: { type: 'resource', resource: { uri, text, mimeType } } inside a prompt message -->
<!-- code: a prompt message whose content embeds a resource the server also registers -->

## Offer argument autocompletion
<!-- teaches: hand-off - wrap an argsSchema field with completable(); full treatment on servers/completion.md -->
<!-- code: one line - completable(z.string(), value => [...]) inside argsSchema; cross-link servers/completion.md -->

## Recap
<!-- the claims this page will prove:
- registerPrompt(name, config, callback) registers a prompt; clients discover it via prompts/list.
- argsSchema is one Zod object: validated arguments, inferred callback types, the argument list clients see.
- The callback returns { messages: [...] }; each message names a role and one content item.
- Messages can embed resources, not only text.
- completable() adds per-argument autocompletion.
-->
