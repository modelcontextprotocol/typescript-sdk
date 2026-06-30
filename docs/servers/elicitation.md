---
status: scaffold
shape: how-to
---
# Elicitation

<!-- SCAFFOLD - structure only; prose comes in a later tranche.
scope: Ask the user (form mode, URL mode).
teaches: ctx.mcpReq.elicitInput, ElicitRequestFormParams, ElicitRequestURLParams, ElicitResult.action
source: mined from docs/server.md "Elicitation"
-->

## Ask for input with a form
<!-- teaches: ctx.mcpReq.elicitInput({ mode: 'form', message, requestedSchema }) | salvage: docs/server.md "Elicitation" (registerTool_elicitation) -->

```ts
// draft - API verified against packages/core-internal/src/shared/protocol.ts (ServerContext.mcpReq.elicitInput, line 470)
server.registerTool(
  'collect-feedback',
  {
    description: 'Collect user feedback via a form',
    inputSchema: z.object({}),
  },
  async (_args, ctx) => {
    const result = await ctx.mcpReq.elicitInput({
      mode: 'form',
      message: 'Please share your feedback:',
      requestedSchema: {
        type: 'object',
        properties: {
          rating: { type: 'number', title: 'Rating (1-5)', minimum: 1, maximum: 5 },
          comment: { type: 'string', title: 'Comment' },
        },
        required: ['rating'],
      },
    });
    if (result.action === 'accept') {
      return { content: [{ type: 'text', text: `Thanks! ${JSON.stringify(result.content)}` }] };
    }
    return { content: [{ type: 'text', text: 'Feedback declined.' }] };
  }
);
```
<!-- result: the host renders the form; result.action is 'accept' | 'decline' | 'cancel' and result.content holds the fields. -->
<!-- aside (::: info): elicitInput is a push and throws on a 2026-07-28 connection, where a handler
     RETURNS the request instead — one line, cross-link servers/input-required.md, which owns that
     form. Era detail is one line linking /protocol-versions. -->

## Handle every action
<!-- teaches: ElicitResult.action branches (accept / decline / cancel) and treating result.content as untrusted input -->
<!-- code: a switch over result.action returning a distinct CallToolResult per branch -->
<!-- result: the verbatim tool output for a decline -->

## Send the end user to a URL
<!-- teaches: mode: 'url' for secure flows (sign-in, payment, API keys) | salvage: docs/server.md "Elicitation" URL mode -->
<!-- code: ctx.mcpReq.elicitInput({ mode: 'url', message, url, elicitationId }) -->

## Keep secrets out of forms
<!-- teaches: the spec rule - never collect sensitive data via form mode; use URL mode or out-of-band | salvage: docs/server.md "Elicitation" IMPORTANT box -->
<!-- code: none -->
<!-- ::: warning placeholder: sensitive information must not be collected via form elicitation -->

## Require the elicitation capability
<!-- teaches: the client must declare elicitation; calls against a client without it fail before reaching the wire -->
<!-- code: none; one line on the error the handler observes -->

## Recap
<!-- the claims this page will prove:
- ctx.mcpReq.elicitInput sends an elicitation request mid-handler and resolves with the end user's answer.
- Form mode carries a JSON-Schema requestedSchema; the result's action is accept, decline, or cancel.
- URL mode hands the end user a browser flow; use it for anything sensitive.
- Elicitation only works against clients that declared the capability.
-->
