---
'@modelcontextprotocol/core-internal': patch
'@modelcontextprotocol/server': patch
---

A tool handler may now return a result without `content`. `ToolCallback` and `LegacyToolCallback` returned `CallToolResult`, the shape parsing produces, where `content` is always an array because `CallToolResultSchema` defaults it to `[]` — so a handler that returned only `structuredContent` failed to compile even though the server has always accepted it (`normalizeContentlessToolResult` fills `content: []` before validation, and `isSpecType.CallToolResult({})` is documented as true for that reason). The specification makes the serialized-JSON TextContent block a SHOULD for a tool returning structured content, not a MUST (#2755). The new `CallToolResultInput` is derived from the same schema through `z.input`, so it differs from `CallToolResult` in `content` alone; every other member keeps its type. Type-only, and a widening — a handler that writes `content` today is unaffected.
