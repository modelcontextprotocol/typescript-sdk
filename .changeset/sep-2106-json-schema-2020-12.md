---
'@modelcontextprotocol/core': minor
'@modelcontextprotocol/server': minor
'@modelcontextprotocol/client': minor
---

Implement SEP-2106: tool `inputSchema`/`outputSchema` conform to JSON Schema 2020-12, and `structuredContent` may be any JSON value.

- `inputSchema` still requires `type: "object"` at the root but now accepts any JSON Schema 2020-12 keyword (`oneOf`/`anyOf`/`allOf`/`not`, `if`/`then`/`else`, `$ref`/`$defs`/`$anchor`, …).
- `outputSchema` may now be **any** valid JSON Schema 2020-12 — objects, arrays, primitives, or compositions — instead of being restricted to `type: "object"`.
- `CallToolResult.structuredContent` widens from `{ [key: string]: unknown }` to `unknown`. **This is a source-breaking type change** for typed consumers: property access now requires a runtime narrowing guard before reading object properties.
- New `CallToolResultWithStructuredContent<T>` type for APIs whose output shape is known ahead of time (for example, server-side handlers typed from `outputSchema`).
- `McpServer.registerTool` type-checks a handler's returned `structuredContent` against the tool's `outputSchema` inferred output. **This is a source-breaking type change** for typed servers: handlers that return `unknown`, `Record<string, unknown>`, or another value wider than the schema output must narrow/annotate that value before returning it, or return a literal `isError: true` error result.
- Servers returning array or primitive `structuredContent` automatically also emit a serialized `TextContent` block, so pre-SEP clients can fall back to the text content.
- Built-in validators refuse to dereference non-same-document `$ref`/`$dynamicRef` (SSRF guard) and reject schemas exceeding depth / subschema-count bounds (composition-DoS guard).
- `Client.listTools()` no longer rejects when a single advertised tool's `outputSchema` fails to compile (e.g. it trips the safety guards above): the failure is scoped to the offending tool. Every other tool stays listable and callable; calling the offending tool throws a
  descriptive error instead of silently skipping output validation.
- The default Node validator now uses `Ajv2020`, so the 2020-12 dialect is honored by default (previously `new Ajv()` ran draft-07 semantics and silently ignored keywords such as `prefixItems`). Both built-in validators now default to the `2020-12` dialect
  (`MCP_DEFAULT_SCHEMA_DIALECT`).
- For compatibility with existing draft-07 tuple schemas, built-in validators using the default 2020-12 dialect normalize legacy `items: [...]` plus `additionalItems` syntax to the equivalent 2020-12 `prefixItems`/`items` form before compiling. New schemas should prefer
  `prefixItems` directly.
- New opt-in `resolveExternalSchemaRefs(schema, options)` helper (the SEP's optional external-`$ref` mode): fetches and inlines non-local `$ref`s ahead of time into a self-contained schema. Disabled by default, enforces a host allowlist (and rejects loopback/link-local/private
  targets otherwise), `https`-only by default, with fetch timeout / response-size / document-count limits, dereference logging, and fail-closed on unresolved references.
