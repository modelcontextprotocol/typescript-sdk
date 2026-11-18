---
'@modelcontextprotocol/server': minor
---

`McpServer.registerTool` now type-checks a callback's successful result against the tool's `outputSchema`, for Standard Schema and deprecated raw-shape schemas. A successful result must include `structuredContent` that matches the schema and is not `undefined`; `isError: true` results, input-required results, tools without an `outputSchema`, and tools whose schema has an `unknown` output type (such as an untyped `fromJsonSchema(...)`) are unchanged. Runtime output validation is unchanged.

New exported types: `ToolResultFor`, `ToolStructuredContent`, `ToolResultWithStructuredContent`, `ToolErrorResult`. `ToolCallback` takes an optional second type parameter for the output schema.

Code that compiled before can now fail to compile, for a tool with a typed `outputSchema`, when the callback:

- returns `structuredContent` that does not match the schema, or a successful result without it;
- builds the value from a wider type than the schema (e.g. `string` for an enum);
- has its result typed as plain `CallToolResult` (a `Promise<CallToolResult>` annotation, a helper returning `CallToolResult`, or `ToolCallback<typeof inputSchema>`); use `ToolCallback<typeof inputSchema, typeof outputSchema>` or drop the annotation;
- is registered with a typed `outputSchema` that may be `undefined`, which is checked as if present.
