---
status: scaffold
shape: how-to
---
# Call tools, read resources, get prompts

<!-- SCAFFOLD - structure only; prose comes in a later tranche.
scope: The verbs; auto-aggregating pagination.
teaches: Client.listTools, Client.callTool, Client.listResources, Client.readResource, Client.listResourceTemplates, Client.listPrompts, Client.getPrompt, Client.complete, ClientOptions.listMaxPages, CallToolRequestOptions.onprogress
source: mined from docs/client.md "Tools", "Resources", "Prompts", "Completions", "Tracking progress"
-->

## List the tools and call one

<!-- teaches: Client.listTools, Client.callTool | salvage: docs/client.md "Tools" -->

```ts
// draft - API verified against packages/client/src/client/client.ts (listTools: ListToolsResult, callTool: CallToolResult)
const { tools } = await client.listTools();

const result = await client.callTool({
  name: 'calculate-bmi',
  arguments: { weightKg: 70, heightM: 1.75 },
});
console.log(result.content);
```

<!-- result: result.content is the model-facing content array; quote the real printed output from the companion example. -->

## Let the SDK walk the pages

<!-- teaches: auto-aggregating pagination, ClientOptions.listMaxPages, LIST_PAGINATION_EXCEEDED | salvage: docs/client.md "Tools" (aggregate-walk paragraph) -->
<!-- code: listTools() with no cursor returns the COMPLETE list; { cursor } opts into per-page control; listMaxPages caps the walk -->
<!-- aside: ::: warning — a server whose pagination never terminates rejects with SdkError LIST_PAGINATION_EXCEEDED -->

## Read structured output

<!-- teaches: CallToolResult.structuredContent | salvage: docs/client.md "Tools" (structuredContent block) -->
<!-- code: check result.structuredContent !== undefined and narrow the unknown before use -->

## Read a resource

<!-- teaches: Client.listResources, Client.readResource, Client.listResourceTemplates | salvage: docs/client.md "Resources" -->
<!-- code: listResources() then readResource({ uri }) iterating contents -->

## Get a prompt

<!-- teaches: Client.listPrompts, Client.getPrompt | salvage: docs/client.md "Prompts" -->
<!-- code: listPrompts() then getPrompt({ name, arguments }) returning messages -->

## Autocomplete an argument

<!-- teaches: Client.complete | salvage: docs/client.md "Completions" -->
<!-- code: client.complete({ ref, argument }) returning completion.values -->

## Track progress on a long call

<!-- teaches: CallToolRequestOptions.onprogress, resetTimeoutOnProgress, maxTotalTimeout | salvage: docs/client.md "Tracking progress" -->
<!-- code: callTool(params, { onprogress, resetTimeoutOnProgress: true, maxTotalTimeout }) -->

## Recap

<!-- the claims this page will prove:
- listTools/listResources/listResourceTemplates/listPrompts auto-aggregate every page; pass { cursor } only when you want per-page control.
- callTool returns content for the model and optionally structuredContent for your application.
- readResource and getPrompt mirror the same list-then-fetch shape.
- complete() autocompletes a prompt or resource-template argument.
- onprogress on the call options streams progress without changing the return type.
-->
