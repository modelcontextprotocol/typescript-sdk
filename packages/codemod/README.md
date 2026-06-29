# @modelcontextprotocol/codemod

Codemods for migrating MCP TypeScript SDK code between major versions.

## Usage

```bash
npx @modelcontextprotocol/codemod@alpha v1-to-v2 .

# or a single source file (manifest changes are reported, not applied)
npx @modelcontextprotocol/codemod@alpha v1-to-v2 src/server.ts
```

The codemod rewrites TypeScript and JavaScript source files
(`.ts`/`.tsx`/`.mts`/`.cts`/`.js`/`.jsx`/`.mjs`/`.cjs`) in place. Run it on a clean
working tree so you can review the diff.

## What `v1-to-v2` covers

The mechanical rename mappings are the source of truth — see
`src/migrations/v1-to-v2/mappings/`:

- [`importMap.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/codemod/src/migrations/v1-to-v2/mappings/importMap.ts) —
  `@modelcontextprotocol/sdk/...` import paths → v2 packages
- [`symbolMap.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/codemod/src/migrations/v1-to-v2/mappings/symbolMap.ts) —
  symbol renames (`McpError` → `ProtocolError`, …)
- [`schemaToMethodMap.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/codemod/src/migrations/v1-to-v2/mappings/schemaToMethodMap.ts) —
  `setRequestHandler(Schema, …)` → `setRequestHandler('method/string', …)`
- [`contextPropertyMap.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/codemod/src/migrations/v1-to-v2/mappings/contextPropertyMap.ts) —
  `extra.*` → `ctx.mcpReq.*` / `ctx.http?.*`

Transforms in `src/migrations/v1-to-v2/transforms/` also rewrite `.tool()` →
`registerTool` (wrapping `inputSchema` / `outputSchema` / `argsSchema` / `uriSchema`
raw shapes with `z.object()`), drop the result-schema argument from `client.request()`
/ `client.callTool()` for spec methods, route spec `*Schema` imports to
`@modelcontextprotocol/core`, rename
`StreamableHTTPError` → `SdkHttpError` / `IsomorphicHeaders` → `Headers`, rewrite
`SchemaInput<T>` → `StandardSchemaWithJSON.InferInput<T>`, route
`ErrorCode.{RequestTimeout,ConnectionClosed}` to `SdkErrorCode` (rewriting an
all-SDK condition's `instanceof ProtocolError` guard to `SdkError`, and marking
guards that mix the two enums), add `import { z } from 'zod'` when a wrap needs
it, rewrite `vi.mock`
/ `jest.mock` / dynamic `import()` paths, invert optional completable nesting
(`completable(schema.optional(), cb)` becomes `completable(schema, cb).optional()`),
and drop `Protocol` / `mergeCapabilities` (no v2 export) with an action-required
marker naming the replacement.

## `@mcp-codemod-error` markers

When the codemod recognizes a v1 pattern but cannot safely rewrite it (ambiguous
context, removed API with no mechanical replacement, signature change requiring
judgment), it leaves the code unchanged and inserts a comment:

```typescript
/* @mcp-codemod-error WebSocketClientTransport removed in v2. Use StreamableHTTPClientTransport or StdioClientTransport. */
```

After running the codemod, find every site that needs attention:

```bash
grep -rn '@mcp-codemod-error' .
```

## What it does NOT cover

CJS→ESM / Node 20 pre-flight, header **read** rewrites (`ctx.http?.req?.headers`
bracket access → `.get()`; sending plain-record headers keeps working), OAuth
error-class consolidation (`instanceof InvalidGrantError` → `OAuthError` +
`OAuthErrorCode`), per-scenario `SdkErrorCode` branch selection, `ctx.mcpReq.send()`
schema-arg drop, and behavioral adaptation are manual — see the
[migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md) for what to do after the
codemod runs.

The codemod handles the v1→v2 SDK surface upgrade only. Adopting the 2026-07-28
protocol revision (`createMcpHandler`, multi-round-trip requests, `versionNegotiation`)
is architectural and not codemod-automatable — see
[docs/migration/support-2026-07-28.md](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md).
