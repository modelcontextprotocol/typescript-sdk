---
status: scaffold
shape: how-to
---
# Completion

<!-- SCAFFOLD - structure only; prose comes in a later tranche.
scope: Autocomplete a schema field.
teaches: completable, CompleteCallback, ResourceTemplate complete callbacks
source: mined from docs/server.md "Completions"
-->

## Wrap an argument with `completable`
<!-- teaches: completable(schema, complete) on a registerPrompt argsSchema field | salvage: docs/server.md "Completions" (registerPrompt_completion) -->

```ts
// draft - API verified against packages/server/src/server/completable.ts (completable, line 51)
server.registerPrompt(
  'review-code',
  {
    title: 'Code Review',
    description: 'Review code for best practices',
    argsSchema: z.object({
      language: completable(z.string().describe('Programming language'), value =>
        ['typescript', 'javascript', 'python', 'rust', 'go'].filter(lang => lang.startsWith(value))
      ),
    }),
  },
  ({ language }) => ({
    messages: [
      {
        role: 'user' as const,
        content: { type: 'text' as const, text: `Review this ${language} code for best practices.` },
      },
    ],
  })
);
```
<!-- result: a completion/complete request for `language` with value "ty" returns ["typescript"]. -->

## Return suggestions from the complete callback
<!-- teaches: CompleteCallback signature - (value, context?) => values[] (sync or async) | source: packages/server/src/server/completable.ts CompleteCallback -->
<!-- code: an async complete callback that queries a list and filters by the typed prefix -->
<!-- result: the completion/complete result the client sees (values array) -->

## Use the other arguments for context
<!-- teaches: the optional second parameter - context.arguments carries the values already filled in for the other arguments -->
<!-- code: a complete callback that narrows suggestions using context?.arguments?.someOtherField -->

## Complete a resource template variable
<!-- teaches: ResourceTemplate's `complete` callback map keyed by variable name | source: packages/server/src/server/mcp.ts ResourceTemplate constructor -->
<!-- code: new ResourceTemplate('user://{userId}/profile', { list: ..., complete: { userId: async value => [...] } }) -->

## Try it from a client
<!-- teaches: what the host does with completions (Inspector / a client's complete() call); the capability is advertised automatically -->
<!-- code: the completion/complete request and its result, verbatim -->

## Recap
<!-- the claims this page will prove:
- completable(schema, callback) attaches autocompletion to one schema field; the schema still validates as before.
- The callback receives the partial value and returns the suggestion list.
- context.arguments lets one field's suggestions depend on another's value.
- Resource template variables complete through the template's `complete` map, not completable().
- The server advertises the completions capability for you.
-->
