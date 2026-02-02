---
name: migrate-v1-to-v2
description: Migrate MCP TypeScript SDK code from v1 (@modelcontextprotocol/sdk) to v2 (@modelcontextprotocol/core, /client, /server). Use when a user asks to migrate, upgrade, or port their MCP TypeScript code from v1 to v2.
---

# MCP TypeScript SDK: v1 → v2 Migration

Apply these changes in order: dependencies → imports → API calls → type aliases.

## 1. Environment

- Node.js 20+ required (v18 dropped)
- ESM only (CJS dropped). If the project uses `require()`, convert to `import`/`export` or use dynamic `import()`.

## 2. Dependencies

Remove the old package and install only what you need:

```bash
npm uninstall @modelcontextprotocol/sdk
```

| You need | Install |
|----------|---------|
| Client only | `npm install @modelcontextprotocol/client` |
| Server only | `npm install @modelcontextprotocol/server` |
| Server + Node.js HTTP | `npm install @modelcontextprotocol/server @modelcontextprotocol/node` |
| Server + Express | `npm install @modelcontextprotocol/server @modelcontextprotocol/express` |
| Server + Hono | `npm install @modelcontextprotocol/server @modelcontextprotocol/hono` |

`@modelcontextprotocol/core` is installed automatically as a dependency.

## 3. Import Mapping

Replace all `@modelcontextprotocol/sdk/...` imports using this table.

### Client imports

| v1 import path | v2 package |
|----------------|------------|
| `@modelcontextprotocol/sdk/client/index.js` | `@modelcontextprotocol/client` |
| `@modelcontextprotocol/sdk/client/auth.js` | `@modelcontextprotocol/client` |
| `@modelcontextprotocol/sdk/client/streamableHttp.js` | `@modelcontextprotocol/client` |
| `@modelcontextprotocol/sdk/client/sse.js` | `@modelcontextprotocol/client` |
| `@modelcontextprotocol/sdk/client/stdio.js` | `@modelcontextprotocol/client` |
| `@modelcontextprotocol/sdk/client/websocket.js` | `@modelcontextprotocol/client` |

### Server imports

| v1 import path | v2 package |
|----------------|------------|
| `@modelcontextprotocol/sdk/server/mcp.js` | `@modelcontextprotocol/server` |
| `@modelcontextprotocol/sdk/server/index.js` | `@modelcontextprotocol/server` |
| `@modelcontextprotocol/sdk/server/stdio.js` | `@modelcontextprotocol/server` |
| `@modelcontextprotocol/sdk/server/streamableHttp.js` | `@modelcontextprotocol/node` (renamed, see below) |
| `@modelcontextprotocol/sdk/server/sse.js` | REMOVED (migrate to Streamable HTTP) |
| `@modelcontextprotocol/sdk/server/auth/*` | REMOVED (use external auth library) |

### Types / shared imports

| v1 import path | v2 package |
|----------------|------------|
| `@modelcontextprotocol/sdk/types.js` | `@modelcontextprotocol/core` |
| `@modelcontextprotocol/sdk/shared/protocol.js` | `@modelcontextprotocol/core` |
| `@modelcontextprotocol/sdk/shared/transport.js` | `@modelcontextprotocol/core` |
| `@modelcontextprotocol/sdk/shared/stdio.js` | `@modelcontextprotocol/core` |
| `@modelcontextprotocol/sdk/shared/uriTemplate.js` | `@modelcontextprotocol/core` |
| `@modelcontextprotocol/sdk/shared/auth.js` | `@modelcontextprotocol/core` |

Note: `@modelcontextprotocol/client` and `@modelcontextprotocol/server` both re-export everything from `@modelcontextprotocol/core`, so you can import types from whichever package you already depend on.

## 4. Renamed Symbols

| v1 symbol | v2 symbol | v2 package |
|-----------|-----------|------------|
| `StreamableHTTPServerTransport` | `NodeStreamableHTTPServerTransport` | `@modelcontextprotocol/node` |

## 5. Removed Type Aliases

| v1 (removed) | v2 (replacement) |
|--------------|------------------|
| `JSONRPCError` | `JSONRPCErrorResponse` |
| `JSONRPCErrorSchema` | `JSONRPCErrorResponseSchema` |
| `isJSONRPCError` | `isJSONRPCErrorResponse` |
| `isJSONRPCResponse` | `isJSONRPCResultResponse` |
| `ResourceReference` | `ResourceTemplateReference` |
| `ResourceReferenceSchema` | `ResourceTemplateReferenceSchema` |

## 6. McpServer API Changes

The variadic `.tool()`, `.prompt()`, `.resource()` methods are removed. Use the `register*` methods with a config object.

### Tools

```typescript
// v1: server.tool(name, schema, callback)
server.tool('greet', { name: z.string() }, async ({ name }) => {
  return { content: [{ type: 'text', text: `Hello, ${name}!` }] };
});

// v1: server.tool(name, description, schema, callback)
server.tool('greet', 'Greet a user', { name: z.string() }, async ({ name }) => {
  return { content: [{ type: 'text', text: `Hello, ${name}!` }] };
});

// v2: server.registerTool(name, config, callback)
server.registerTool('greet', {
  description: 'Greet a user',
  inputSchema: { name: z.string() },
}, async ({ name }) => {
  return { content: [{ type: 'text', text: `Hello, ${name}!` }] };
});
```

Config object fields: `title?`, `description?`, `inputSchema?`, `outputSchema?`, `annotations?`, `_meta?`

### Prompts

```typescript
// v1: server.prompt(name, schema, callback)
server.prompt('summarize', { text: z.string() }, async ({ text }) => {
  return { messages: [{ role: 'user', content: { type: 'text', text } }] };
});

// v2: server.registerPrompt(name, config, callback)
server.registerPrompt('summarize', {
  argsSchema: { text: z.string() },
}, async ({ text }) => {
  return { messages: [{ role: 'user', content: { type: 'text', text } }] };
});
```

Config object fields: `title?`, `description?`, `argsSchema?`

### Resources

```typescript
// v1: server.resource(name, uri, callback)
server.resource('config', 'config://app', async (uri) => {
  return { contents: [{ uri: uri.href, text: '{}' }] };
});

// v2: server.registerResource(name, uri, metadata, callback)
server.registerResource('config', 'config://app', {}, async (uri) => {
  return { contents: [{ uri: uri.href, text: '{}' }] };
});
```

Note: the third argument (`metadata`) is required — pass `{}` if no metadata.

## 7. Headers API

Transport constructors now use the `Headers` object instead of plain objects for headers.

```typescript
// v1
headers: { 'Authorization': 'Bearer token' }

// v2
headers: new Headers({ 'Authorization': 'Bearer token' })
```

## 8. Removed Server Features

### SSE server transport

Removed entirely. Migrate to Streamable HTTP transport. Client-side SSE transport is still available for connecting to legacy servers.

### Server-side auth

Removed from the SDK. Use an external auth library (e.g., `better-auth`). See `examples/server/src/` for demos.

## 9. Migration Steps (for applying to a codebase)

1. Update `package.json`: replace `@modelcontextprotocol/sdk` with the appropriate v2 packages
2. Find all imports from `@modelcontextprotocol/sdk/...` and replace using the import mapping table
3. Rename `StreamableHTTPServerTransport` → `NodeStreamableHTTPServerTransport`
4. Replace `.tool()` / `.prompt()` / `.resource()` calls with `registerTool` / `registerPrompt` / `registerResource`
5. Replace removed type aliases (`JSONRPCError` → `JSONRPCErrorResponse`, etc.)
6. Replace plain header objects with `new Headers({...})` in transport constructors
7. If using server SSE transport, migrate to Streamable HTTP
8. If using server auth from the SDK, migrate to an external auth library
9. Verify: build with `tsc` / run tests
