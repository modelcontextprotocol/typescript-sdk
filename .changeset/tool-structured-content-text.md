---
'@modelcontextprotocol/server': minor
---

A `McpServer.registerTool` result with `structuredContent` and no `content` now gets a text block holding the serialized JSON of `structuredContent`, as the tools spec recommends, instead of `content: []`. A result that supplies `content`, even an empty array, is unchanged. To match, successful results of a tool with an `outputSchema` may now omit `content` in TypeScript (`ToolResultWithStructuredContent['content']` is optional).
