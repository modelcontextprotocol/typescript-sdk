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
| `@modelcontextprotocol/sdk/server/streamableHttp.js` | `@modelcontextprotocol/node` (class renamed to `NodeStreamableHTTPServerTransport`) |
| `@modelcontextprotocol/sdk/server/sse.js` | REMOVED (migrate to Streamable HTTP) |
| `@modelcontextprotocol/sdk/server/auth/*` | REMOVED (use external auth library) |
| `@modelcontextprotocol/sdk/server/middleware.js` | `@modelcontextprotocol/express` (signature changed, see section 8) |

### Types / shared imports

| v1 import path | v2 package |
|----------------|------------|
| `@modelcontextprotocol/sdk/types.js` | `@modelcontextprotocol/core` |
| `@modelcontextprotocol/sdk/shared/protocol.js` | `@modelcontextprotocol/core` |
| `@modelcontextprotocol/sdk/shared/transport.js` | `@modelcontextprotocol/core` |
| `@modelcontextprotocol/sdk/shared/stdio.js` | `@modelcontextprotocol/core` |
| `@modelcontextprotocol/sdk/shared/uriTemplate.js` | `@modelcontextprotocol/core` |
| `@modelcontextprotocol/sdk/shared/auth.js` | `@modelcontextprotocol/core` |

Notes:
- `@modelcontextprotocol/client` and `@modelcontextprotocol/server` both re-export everything from `@modelcontextprotocol/core`, so you can import types from whichever package you already depend on.
- When multiple v1 imports map to the same v2 package, consolidate them into a single import statement.
- If code imports from `sdk/client/...`, install `@modelcontextprotocol/client`. If from `sdk/server/...`, install `@modelcontextprotocol/server`. If from `sdk/types.js` or `sdk/shared/...` only, install `@modelcontextprotocol/core`.

## 4. Renamed Symbols

| v1 symbol | v2 symbol | v2 package |
|-----------|-----------|------------|
| `StreamableHTTPServerTransport` | `NodeStreamableHTTPServerTransport` | `@modelcontextprotocol/node` |

## 5. Removed / Renamed Type Aliases and Symbols

| v1 (removed) | v2 (replacement) |
|--------------|------------------|
| `JSONRPCError` | `JSONRPCErrorResponse` |
| `JSONRPCErrorSchema` | `JSONRPCErrorResponseSchema` |
| `isJSONRPCError` | `isJSONRPCErrorResponse` |
| `isJSONRPCResponse` | `isJSONRPCResultResponse` |
| `ResourceReference` | `ResourceTemplateReference` |
| `ResourceReferenceSchema` | `ResourceTemplateReferenceSchema` |
| `IsomorphicHeaders` | REMOVED (use Web Standard `Headers`) |
| `AuthInfo` (from `server/auth/types.js`) | `AuthInfo` (now in `@modelcontextprotocol/core`) |

All other symbols from `@modelcontextprotocol/sdk/types.js` retain their original names (e.g., `CallToolResultSchema`, `ListToolsResultSchema`, etc.).

**Unchanged APIs** (only import paths changed): `Client` constructor and methods, `McpServer` constructor, `server.connect()`, `server.close()`, all client transports (`StreamableHTTPClientTransport`, `SSEClientTransport`, `StdioClientTransport`), `StdioServerTransport`, all Zod schemas, all callback return types.

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

Transport constructors and `RequestInfo.headers` now use the Web Standard `Headers` object instead of plain objects.

```typescript
// v1: plain object, bracket access
headers: { 'Authorization': 'Bearer token' }
extra.requestInfo?.headers['mcp-session-id']

// v2: Headers object, .get() access
headers: new Headers({ 'Authorization': 'Bearer token' })
extra.requestInfo?.headers.get('mcp-session-id')
```

## 8. Removed Server Features

### SSE server transport

`SSEServerTransport` removed entirely. Migrate to `NodeStreamableHTTPServerTransport` (from `@modelcontextprotocol/node`). Client-side `SSEClientTransport` still available for connecting to legacy servers.

### Server-side auth

All server OAuth exports removed: `mcpAuthRouter`, `OAuthServerProvider`, `OAuthTokenVerifier`, `requireBearerAuth`, `authenticateClient`, `ProxyOAuthServerProvider`, `allowedMethods`, and associated types. Use an external auth library (e.g., `better-auth`). See `examples/server/src/` for demos.

### Host header validation (Express)

`hostHeaderValidation()` and `localhostHostValidation()` moved from server package to `@modelcontextprotocol/express`. Signature changed: takes `string[]` instead of options object.

```typescript
// v1
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware.js';
app.use(hostHeaderValidation({ allowedHosts: ['example.com'] }));

// v2
import { hostHeaderValidation } from '@modelcontextprotocol/express';
app.use(hostHeaderValidation(['example.com']));
```

The server package now exports framework-agnostic alternatives: `validateHostHeader()`, `localhostAllowedHostnames()`, `hostHeaderValidationResponse()`.

## 9. `setRequestHandler` / `setNotificationHandler` API

The low-level handler registration methods now take a method string instead of a Zod schema.

```typescript
// v1: schema-based
server.setRequestHandler(InitializeRequestSchema, async (request) => { ... });
server.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => { ... });

// v2: method string
server.setRequestHandler('initialize', async (request) => { ... });
server.setNotificationHandler('notifications/message', (notification) => { ... });
```

Schema to method string mapping:

| v1 Schema | v2 Method String |
|-----------|-----------------|
| `InitializeRequestSchema` | `'initialize'` |
| `CallToolRequestSchema` | `'tools/call'` |
| `ListToolsRequestSchema` | `'tools/list'` |
| `ListPromptsRequestSchema` | `'prompts/list'` |
| `GetPromptRequestSchema` | `'prompts/get'` |
| `ListResourcesRequestSchema` | `'resources/list'` |
| `ReadResourceRequestSchema` | `'resources/read'` |
| `CreateMessageRequestSchema` | `'sampling/createMessage'` |
| `ElicitRequestSchema` | `'elicitation/create'` |
| `SetLevelRequestSchema` | `'logging/setLevel'` |
| `PingRequestSchema` | `'ping'` |
| `LoggingMessageNotificationSchema` | `'notifications/message'` |
| `ToolListChangedNotificationSchema` | `'notifications/tools/list_changed'` |
| `ResourceListChangedNotificationSchema` | `'notifications/resources/list_changed'` |
| `PromptListChangedNotificationSchema` | `'notifications/prompts/list_changed'` |
| `ProgressNotificationSchema` | `'notifications/progress'` |
| `CancelledNotificationSchema` | `'notifications/cancelled'` |
| `InitializedNotificationSchema` | `'notifications/initialized'` |

Request/notification params remain fully typed. Remove unused schema imports after migration.

## 10. Client Behavioral Changes

`Client.listPrompts()`, `listResources()`, `listResourceTemplates()`, `listTools()` now return empty results when the server lacks the corresponding capability (instead of sending the request). Set `enforceStrictCapabilities: true` in `ClientOptions` to throw an error instead.

## 11. Migration Steps (apply in this order)

1. Update `package.json`: `npm uninstall @modelcontextprotocol/sdk`, install the appropriate v2 packages
2. Replace all imports from `@modelcontextprotocol/sdk/...` using the import mapping tables (sections 3-4), including `StreamableHTTPServerTransport` → `NodeStreamableHTTPServerTransport`
3. Replace removed type aliases (`JSONRPCError` → `JSONRPCErrorResponse`, etc.) per section 5
4. Replace `.tool()` / `.prompt()` / `.resource()` calls with `registerTool` / `registerPrompt` / `registerResource` per section 6
5. Replace plain header objects with `new Headers({...})` and bracket access (`headers['x']`) with `.get()` calls per section 7
6. If using `hostHeaderValidation` from server, update import and signature per section 8
7. If using server SSE transport, migrate to Streamable HTTP
8. If using server auth from the SDK, migrate to an external auth library
9. If relying on `listTools()`/`listPrompts()`/etc. throwing on missing capabilities, set `enforceStrictCapabilities: true`
10. Verify: build with `tsc` / run tests
