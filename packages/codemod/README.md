# @modelcontextprotocol/codemod

Codemods for migrating MCP TypeScript SDK code between major versions.

## Usage

```bash
npx @modelcontextprotocol/codemod@alpha v1-to-v2 ./src
```

The codemod rewrites TypeScript and JavaScript source files
(`.ts`/`.tsx`/`.mts`/`.cts`/`.js`/`.jsx`/`.mjs`/`.cjs`) in place. Run it on a clean
working tree so you can review the diff.

## What `v1-to-v2` covers

The mechanical rename mappings are the source of truth — see
`src/migrations/v1-to-v2/mappings/`:

- [`importMap.ts`](./src/migrations/v1-to-v2/mappings/importMap.ts) —
  `@modelcontextprotocol/sdk/...` import paths → v2 packages
- [`symbolMap.ts`](./src/migrations/v1-to-v2/mappings/symbolMap.ts) —
  symbol renames (`McpError` → `ProtocolError`, …)
- [`schemaToMethodMap.ts`](./src/migrations/v1-to-v2/mappings/schemaToMethodMap.ts) —
  `setRequestHandler(Schema, …)` → `setRequestHandler('method/string', …)`
- [`contextPropertyMap.ts`](./src/migrations/v1-to-v2/mappings/contextPropertyMap.ts) —
  `extra.*` → `ctx.mcpReq.*` / `ctx.http?.*`

Transforms in `src/migrations/v1-to-v2/transforms/` also rewrite `.tool()` →
`registerTool` (with `z.object()` wrap), drop the result-schema argument from
`client.request()` / `client.callTool()` for spec methods, rewrite spec-`*Schema`
constant accesses (`.safeParse` → `isSpecType` / `specTypeSchemas`), rename
`StreamableHTTPError` → `SdkHttpError` / `IsomorphicHeaders` → `Headers`, rewrite
`SchemaInput<T>` → `StandardSchemaWithJSON.InferInput<T>`, route
`ErrorCode.{RequestTimeout,ConnectionClosed}` to `SdkErrorCode`, and rewrite `vi.mock`
/ `jest.mock` / dynamic `import()` paths.

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

CJS→ESM / Node 20 pre-flight, `new Headers()` / `.get()` access rewrites, OAuth
error-class consolidation (`instanceof InvalidGrantError` → `OAuthError` +
`OAuthErrorCode`), per-scenario `SdkErrorCode` branch selection, `outputSchema`
`z.object()` wrap, `ctx.mcpReq.send()` schema-arg drop, and behavioral adaptation are
manual — see the [migration guide](../../docs/migration/upgrade-to-v2.md) for what to
do after the codemod runs.

The codemod handles the v1→v2 SDK surface upgrade only. Adopting the 2026-07-28
protocol revision (`createMcpHandler`, multi-round-trip requests, `versionNegotiation`)
is architectural and not codemod-automatable — see
[docs/migration/support-2026-07-28.md](../../docs/migration/support-2026-07-28.md).
