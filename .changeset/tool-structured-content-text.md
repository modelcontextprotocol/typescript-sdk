---
'@modelcontextprotocol/server': minor
---

A `McpServer` tool result with `structuredContent` and no `content` now gets a text block holding the serialized JSON of `structuredContent`, as the tools spec recommends, instead of `content: []`. This applies to every tool result, with or without an `outputSchema` or `isError`. A result that supplies `content`, even an empty array, is handled as before. To match, successful results of a tool with an `outputSchema` may omit `content` in TypeScript, both in `registerTool` and in `RegisteredTool.update({ callback })`.
