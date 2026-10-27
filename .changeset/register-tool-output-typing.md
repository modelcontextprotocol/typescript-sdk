---
'@modelcontextprotocol/server': minor
---

`McpServer.registerTool` now type-checks a callback's successful result against the tool's `outputSchema`, for Standard Schema and deprecated raw-shape schemas. A successful result must include `structuredContent` that matches the schema and is not `undefined`; `isError: true` results, input-required results and tools without an `outputSchema` are unchanged. Runtime output validation is unchanged.

Successful typed results may omit `content`. `McpServer` then sends the JSON of `structuredContent` as a text block (previously a content-less result was sent with `content: []`).

New exported types: `ToolResultFor`, `ToolStructuredContent`, `ToolResultWithStructuredContent`, `ToolErrorResult`. `ToolCallback` takes an optional second type parameter for the output schema.

Code that compiled before can now fail to compile, for a tool with an `outputSchema`, when the callback:

- returns `structuredContent` that does not match the schema, or a successful result without it;
- builds the value from a wider type than the schema (e.g. `string` for an enum);
- has its result typed as plain `CallToolResult` (a `Promise<CallToolResult>` annotation, a helper returning `CallToolResult`, or `ToolCallback<typeof inputSchema>`); use `ToolCallback<typeof inputSchema, typeof outputSchema>` or drop the annotation;
- is registered with an `outputSchema` typed `S | undefined`, which is checked as if present.
