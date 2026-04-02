---
'@modelcontextprotocol/core': minor
'@modelcontextprotocol/server': minor
'@modelcontextprotocol/client': minor
---

Support Standard Schema for tool and prompt schemas

Tool and prompt registration now accepts any schema library that implements the [Standard Schema spec](https://standardschema.dev/): Zod v4, Valibot, ArkType, and others. `RegisteredTool.inputSchema`, `RegisteredTool.outputSchema`, and `RegisteredPrompt.argsSchema` now use `StandardSchemaWithJSON` (requires both `~standard.validate` and `~standard.jsonSchema`) instead of the Zod-specific `AnySchema` type.

**Zod v4 schemas continue to work unchanged** — Zod v4 implements the required interfaces natively.

```typescript
import { type } from 'arktype';

server.registerTool('greet', {
  inputSchema: type({ name: 'string' })
}, async ({ name }) => ({ content: [{ type: 'text', text: `Hello, ${name}!` }] }));
```

For raw JSON Schema (e.g. TypeBox output), use the new `fromJsonSchema` adapter:

```typescript
import { fromJsonSchema, AjvJsonSchemaValidator } from '@modelcontextprotocol/core';

server.registerTool('greet', {
  inputSchema: fromJsonSchema({ type: 'object', properties: { name: { type: 'string' } } }, new AjvJsonSchemaValidator())
}, handler);
```

**Breaking changes:**
- `experimental.tasks.getTaskResult()` no longer accepts a `resultSchema` parameter. Returns `GetTaskPayloadResult` (a loose `Result`); cast to the expected type at the call site.
- Removed unused exports from `@modelcontextprotocol/core`: `SchemaInput`, `schemaToJson`, `parseSchemaAsync`, `getSchemaShape`, `getSchemaDescription`, `isOptionalSchema`, `unwrapOptionalSchema`. Use the new `standardSchemaToJsonSchema` and `validateStandardSchema` instead.
- `completable()` remains Zod-specific (it relies on Zod's `.shape` introspection).
