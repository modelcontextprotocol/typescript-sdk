---
status: scaffold
shape: how-to
---
# Sampling

::: warning Deprecated — SEP-2577
<!-- SUNSET BANNER placeholder. Sampling is deprecated as of protocol version 2026-07-28
(SEP-2577) and remains functional on 2025-era connections for at least twelve months.
Migration target named FIRST: call your LLM provider's API directly from your server.
Link the deprecated-features registry. This banner is the first thing on the page. -->
:::

<!-- SCAFFOLD - structure only; prose comes in a later tranche.
scope: Ask the model — SUNSET-FRAMED (SEP-2577), banner at top, migration target first.
teaches: ctx.mcpReq.requestSampling, CreateMessageRequestParams
source: mined from docs/server.md "Sampling"
mrtr note: inputRequired.createMessage is owned by servers/input-required.md (proposal §1
taxonomy delta); this page carries one cross-link aside, never a second code block.
-->

## Replace sampling with a direct provider call

<!-- teaches: the migration target, not the feature - call your LLM provider's SDK/API from the tool handler with your own key | source: SEP-2577 framing in docs/server.md sampling WARNING; net-new framing mirroring clients/roots.md "Migrate away first" -->
<!-- code: none — this section is the off-ramp; one link to the deprecated-features registry -->

## Request a completion from the client
<!-- teaches: ctx.mcpReq.requestSampling({ messages, maxTokens }) | salvage: docs/server.md "Sampling" (registerTool_sampling) -->

```ts
// draft - API verified against packages/core-internal/src/shared/protocol.ts (ServerContext.mcpReq.requestSampling, line 481)
server.registerTool(
  'summarize',
  {
    description: 'Summarize text using the client LLM',
    inputSchema: z.object({ text: z.string() }),
  },
  async ({ text }, ctx) => {
    const response = await ctx.mcpReq.requestSampling({
      messages: [{ role: 'user', content: { type: 'text', text: `Please summarize:\n\n${text}` } }],
      maxTokens: 500,
    });
    return { content: [{ type: 'text', text: `Model (${response.model}): ${JSON.stringify(response.content)}` }] };
  }
);
```
<!-- result: the client runs the prompt through its model and the handler gets back { model, role, content }. -->
<!-- aside (::: info): requestSampling is a push and throws on a 2026-07-28 connection, where a
     handler RETURNS the embedded request instead — one line, cross-link servers/input-required.md,
     which owns that form. Era detail is one line linking /protocol-versions. -->

## Read the model's reply
<!-- teaches: CreateMessageResult shape - model, role, content; the client picks the model -->
<!-- code: none beyond the lead; the verbatim result object -->
<!-- result: the JSON the handler receives, verbatim -->

## Require the sampling capability
<!-- teaches: the client must declare sampling; the SDK rejects the request before the wire when it did not -->
<!-- code: none; one line on the error surfaced to the handler -->

## Recap
<!-- the claims this page will prove:
- Sampling is sunset (SEP-2577); the migration target is a direct LLM provider call from your server.
- ctx.mcpReq.requestSampling asks the connected client's model for a completion mid-handler.
- The client owns model choice; the result carries model, role, and content.
- It only works when the client declared the sampling capability.
-->
