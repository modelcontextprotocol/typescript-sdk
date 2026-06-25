---
'@modelcontextprotocol/codemod': minor
---

Route v1 `@modelcontextprotocol/sdk/types.js` schema imports to the new `@modelcontextprotocol/sdk-shared` package. The `*Schema` Zod constants now migrate as a behavior-preserving import-path swap — `<Name>Schema.parse(value)` / `.safeParse(value)` keep working — while spec types, error classes, enums, and guards continue to resolve to `@modelcontextprotocol/client` / `@modelcontextprotocol/server` by context. A single `import { CallToolResult, CallToolResultSchema } from '.../types.js'` is split accordingly. The v1 OAuth/OpenID `*Schema` constants imported from `@modelcontextprotocol/sdk/shared/auth.js` are routed to `sdk-shared` the same way (their auth TYPES keep resolving to `client` / `server`). The previous `specSchemaAccess` transform (which rewrote `.parse()` into `specTypeSchemas.X['~standard'].validate(...)`) is removed.
