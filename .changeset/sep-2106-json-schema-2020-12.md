---
'@modelcontextprotocol/core': minor
'@modelcontextprotocol/server': minor
'@modelcontextprotocol/client': minor
---

Implement SEP-2106: tool `inputSchema`/`outputSchema` conform to JSON Schema 2020-12, and `structuredContent` may be any JSON value.

- `inputSchema` still requires `type: "object"` at the root but now accepts any JSON Schema 2020-12 keyword (`oneOf`/`anyOf`/`allOf`/`not`, `if`/`then`/`else`, `$ref`/`$defs`/`$anchor`, …).
- `outputSchema` may now be **any** valid JSON Schema 2020-12 — objects, arrays, primitives, or compositions — instead of being restricted to `type: "object"`.
- `CallToolResult.structuredContent` widens from `{ [key: string]: unknown }` to `unknown`. **This is a source-breaking type change** for typed consumers: property access now requires a narrowing guard or a type argument.
- `client.callTool<T>()` is now generic so callers get a precisely typed `structuredContent` (defaults to `JSONValue`). New `CallToolResultWithStructuredContent<T>` type.
- `McpServer.registerTool` type-checks a handler's returned `structuredContent` against the tool's `outputSchema` inferred output.
- Servers returning array or primitive `structuredContent` automatically also emit a serialized `TextContent` block, so pre-SEP clients can fall back to the text content.
- Built-in validators refuse to dereference non-same-document `$ref`/`$dynamicRef` (SSRF guard) and reject schemas exceeding depth / subschema-count bounds (composition-DoS guard).
