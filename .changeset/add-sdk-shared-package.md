---
'@modelcontextprotocol/sdk-shared': minor
---

Add `@modelcontextprotocol/sdk-shared`: the public home for the MCP specification Zod schemas. It bundles the SDK's internal schema definitions and re-exports only the `*Schema` values, so consumers can validate protocol payloads (`<TypeName>Schema.parse(value)` / `.safeParse(value)`) without depending on a package's internal barrel. Spec types, error classes, enums, and guards continue to live on `@modelcontextprotocol/server` and `@modelcontextprotocol/client`.
