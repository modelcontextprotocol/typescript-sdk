---
name: migrate-v1-to-v2
description: Migrate MCP TypeScript SDK code from v1 (@modelcontextprotocol/sdk) to v2 (@modelcontextprotocol/sdk@^2, or the split /client and /server packages). Use when a user asks to migrate, upgrade, or port their MCP TypeScript code from v1 to v2.
---

# MCP TypeScript SDK: v1 → v2 Migration

**Shortest path for most servers:** bump `@modelcontextprotocol/sdk` to `^2.0.0` and stop. v1 import paths and APIs continue to work as `@deprecated` aliases (IDE strikethrough, no runtime warnings) that forward to the new implementation. If the user only wants to "get on v2", do that, run the build, and
report any IDE-flagged `@deprecated` usages as optional follow-ups.

Apply the rest of this guide when the user wants a **full migration** to the new split packages with no `@deprecated` usages. Order: environment → dependencies → imports → API calls → type aliases.

## 1. Environment

- Node.js 20+ required (v18 dropped)
- ESM only (CJS dropped). If the project uses `require()`, convert to `import`/`export` or use dynamic `import()`.
- `tsconfig.json` must use `"moduleResolution": "bundler"`, `"nodenext"`, or `"node16"`. Legacy `"node"` / `"node10"` cannot resolve v2's `exports`-only packages and fails with `TS2307`. Do **not** add `main`/`types` fields to work around this — fix the tsconfig.
- **Zod must be `^4.2.0`** (if used). zod 3.x and 4.0–4.1 lack `~standard.jsonSchema` and crash at runtime on `tools/list` even though typecheck passes. Import from `'zod'` or `'zod/v4'`.

## 2. Dependencies

Either keep `@modelcontextprotocol/sdk@^2` (meta-package, simplest), **or** remove it and install the split packages:

```bash
npm uninstall @modelcontextprotocol/sdk
```

| You need              | Install                                                                  |
| --------------------- | ------------------------------------------------------------------------ |
| Client only           | `npm install @modelcontextprotocol/client`                               |
| Server only           | `npm install @modelcontextprotocol/server`                               |
| Server + Node.js HTTP | `npm install @modelcontextprotocol/server @modelcontextprotocol/node`    |
| Server + Express      | `npm install @modelcontextprotocol/server @modelcontextprotocol/express` |
| Server + Hono         | `npm install @modelcontextprotocol/server @modelcontextprotocol/hono`    |

`@modelcontextprotocol/core` is an internal package — never install or import it directly. Its contents are bundled into `@modelcontextprotocol/client` and `@modelcontextprotocol/server`, which re-export everything you need.

## 3. Import Mapping

Replace all `@modelcontextprotocol/sdk/...` imports using this table.

### Client imports

| v1 import path                                       | v2 package                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| `@modelcontextprotocol/sdk/client/index.js`          | `@modelcontextprotocol/client`                                                 |
| `@modelcontextprotocol/sdk/client/auth.js`           | `@modelcontextprotocol/client`                                                 |
| `@modelcontextprotocol/sdk/client/streamableHttp.js` | `@modelcontextprotocol/client`                                                 |
| `@modelcontextprotocol/sdk/client/sse.js`            | `@modelcontextprotocol/client`                                                 |
| `@modelcontextprotocol/sdk/client/stdio.js`          | `@modelcontextprotocol/client`                                                 |
| `@modelcontextprotocol/sdk/client/websocket.js`      | REMOVED (use Streamable HTTP or stdio; implement `Transport` for custom needs) |

### Server imports

| v1 import path                                       | v2 package                                                                                                                                                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@modelcontextprotocol/sdk/server/mcp.js`            | `@modelcontextprotocol/server`                                                                                                                                                                                     |
| `@modelcontextprotocol/sdk/server/index.js`          | `@modelcontextprotocol/server`                                                                                                                                                                                     |
| `@modelcontextprotocol/sdk/server/stdio.js`          | `@modelcontextprotocol/server`                                                                                                                                                                                     |
| `@modelcontextprotocol/sdk/server/streamableHttp.js` | `@modelcontextprotocol/node` (class renamed to `NodeStreamableHTTPServerTransport`) OR `@modelcontextprotocol/server` (web-standard `WebStandardStreamableHTTPServerTransport` for Cloudflare Workers, Deno, etc.) |
| `@modelcontextprotocol/sdk/server/sse.js`            | REMOVED (migrate to Streamable HTTP; deprecated copy at `@modelcontextprotocol/node/sse` for proxy/bridge use)                                                                                                     |
| `@modelcontextprotocol/sdk/server/auth/*`            | REMOVED (use external auth library; `requireBearerAuth`/`mcpAuthMetadataRouter` available in `@modelcontextprotocol/express`)                                                                                      |
| `@modelcontextprotocol/sdk/server/auth/errors.js`    | `@modelcontextprotocol/client` or `/server` (see OAuth error consolidation in section 5)                                                                                                                           |
| `@modelcontextprotocol/sdk/server/middleware.js`     | `@modelcontextprotocol/express` (signature changed, see section 8)                                                                                                                                                 |
| `@modelcontextprotocol/sdk/server/express.js`        | `@modelcontextprotocol/express`                                                                                                                                                                                    |

### Types / shared imports

| v1 import path                                    | v2 package                                                       |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| `@modelcontextprotocol/sdk/types.js`              | `@modelcontextprotocol/client` or `@modelcontextprotocol/server` |
| `@modelcontextprotocol/sdk/shared/protocol.js`    | `@modelcontextprotocol/client` or `@modelcontextprotocol/server` |
| `@modelcontextprotocol/sdk/shared/transport.js`   | `@modelcontextprotocol/client` or `@modelcontextprotocol/server` |
| `@modelcontextprotocol/sdk/shared/uriTemplate.js` | `@modelcontextprotocol/client` or `@modelcontextprotocol/server` |
| `@modelcontextprotocol/sdk/shared/auth.js`        | `@modelcontextprotocol/client` or `@modelcontextprotocol/server` |
| `@modelcontextprotocol/sdk/shared/stdio.js`       | `@modelcontextprotocol/client` or `@modelcontextprotocol/server` |
| `@modelcontextprotocol/sdk/inMemory.js`           | `@modelcontextprotocol/client` or `@modelcontextprotocol/server` |

Notes:

- `@modelcontextprotocol/client` and `@modelcontextprotocol/server` both re-export the shared types, so import from whichever package you already depend on. Do not import from `@modelcontextprotocol/core` directly — it is an internal package.
- When multiple v1 imports map to the same v2 package, consolidate them into a single import statement.

## 4. Renamed Symbols

| v1 symbol                       | v2 symbol                           | v2 package                   |
| ------------------------------- | ----------------------------------- | ---------------------------- |
| `StreamableHTTPServerTransport` | `NodeStreamableHTTPServerTransport` | `@modelcontextprotocol/node` |

## 5. Deprecated Type Aliases and Symbols

The v1 names below are still exported as `@deprecated` aliases. Migrate to the v2 names when convenient.

| v1 (`@deprecated`)                                       | v2 (replacement)                                                                                                |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `JSONRPCError`                                           | `JSONRPCErrorResponse`                                                                                          |
| `JSONRPCErrorSchema`                                     | `JSONRPCErrorResponseSchema`                                                                                    |
| `isJSONRPCError`                                         | `isJSONRPCErrorResponse`                                                                                        |
| `isJSONRPCResponse` (deprecated in v1)                   | `isJSONRPCResultResponse` (**not** v2's new `isJSONRPCResponse`, which correctly matches both result and error) |
| `ResourceReference`                                      | `ResourceTemplateReference`                                                                                     |
| `ResourceReferenceSchema`                                | `ResourceTemplateReferenceSchema`                                                                               |
| `ResourceTemplate` (the protocol _type_)                 | `ResourceTemplateType` (`ResourceTemplate` is now the server template _class_)                                  |
| `IsomorphicHeaders`                                      | `Headers` (Web Standard)                                                                                        |
| `RequestInfo` (custom SDK type)                          | `Request` (Web Standard, via `ctx.http?.req`)                                                                   |
| `ZodRawShapeCompat`                                      | `StandardSchemaWithJSON`                                                                                        |
| `AuthInfo` (from `server/auth/types.js`)                 | `AuthInfo` (now re-exported by `@modelcontextprotocol/client` and `@modelcontextprotocol/server`)               |
| `OAuthProtectedResourceMetadata` (from `shared/auth.js`) | `OAuthProtectedResourceMetadata` (re-exported by `@modelcontextprotocol/client` / `server`)                     |
| `OAuthError#errorCode` (instance prop)                   | `OAuthError#code`                                                                                               |
| `JSONRPCMessageSchema.parse(raw)`                        | `parseJSONRPCMessage(raw)`                                                                                      |
| `<Type>Schema.parse(v)` (any spec type)                  | `specTypeSchema('<Type>').parse(v)` / `isSpecType('<Type>', v)`                                                 |
| `McpError`                                               | `ProtocolError`                                                                                                 |
| `ErrorCode`                                              | `ProtocolErrorCode`                                                                                             |
| `ErrorCode.RequestTimeout`                               | `SdkErrorCode.RequestTimeout`                                                                                   |
| `ErrorCode.ConnectionClosed`                             | `SdkErrorCode.ConnectionClosed`                                                                                 |
| `StreamableHTTPError`                                    | `SdkError` with `SdkErrorCode.ClientHttp*`                                                                      |

`WebSocketClientTransport` is **removed** (no deprecated alias). Use `StreamableHTTPClientTransport` or `StdioClientTransport`.

All other **type** symbols from `@modelcontextprotocol/sdk/types.js` retain their original names. **Zod schemas** (e.g., `CallToolResultSchema`, `ListToolsResultSchema`, `OAuthTokensSchema`) are no longer part of the public API. For runtime validation: use
`parseJSONRPCMessage(raw)` for transport framing, `isCallToolResult(v)` for the common case, or `specTypeSchema('<Name>')` / `isSpecType('<Name>', v)` for any other spec type. The raw Zod constants remain available at `@modelcontextprotocol/server/zod-schemas` as a compatibility
escape hatch.

### Error class changes

Two error classes now exist:

- **`ProtocolError`** (renamed from `McpError`): Protocol errors that cross the wire as JSON-RPC responses
- **`SdkError`** (new): Local SDK errors that never cross the wire

| Error scenario                    | v1 type                                      | v2 type                                                           |
| --------------------------------- | -------------------------------------------- | ----------------------------------------------------------------- |
| Request timeout                   | `McpError` with `ErrorCode.RequestTimeout`   | `SdkError` with `SdkErrorCode.RequestTimeout`                     |
| Connection closed                 | `McpError` with `ErrorCode.ConnectionClosed` | `SdkError` with `SdkErrorCode.ConnectionClosed`                   |
| Capability not supported          | `new Error(...)`                             | `SdkError` with `SdkErrorCode.CapabilityNotSupported`             |
| Not connected                     | `new Error('Not connected')`                 | `SdkError` with `SdkErrorCode.NotConnected`                       |
| Invalid params (server response)  | `McpError` with `ErrorCode.InvalidParams`    | `ProtocolError` with `ProtocolErrorCode.InvalidParams`            |
| HTTP transport error              | `StreamableHTTPError`                        | `SdkError` with `SdkErrorCode.ClientHttp*`                        |
| Failed to open SSE stream         | `StreamableHTTPError`                        | `SdkError` with `SdkErrorCode.ClientHttpFailedToOpenStream`       |
| 401 after re-auth (circuit break) | `StreamableHTTPError`                        | `SdkError` with `SdkErrorCode.ClientHttpAuthentication`           |
| 403 after upscoping               | `StreamableHTTPError`                        | `SdkError` with `SdkErrorCode.ClientHttpForbidden`                |
| Unexpected content type           | `StreamableHTTPError`                        | `SdkError` with `SdkErrorCode.ClientHttpUnexpectedContent`        |
| Session termination failed        | `StreamableHTTPError`                        | `SdkError` with `SdkErrorCode.ClientHttpFailedToTerminateSession` |

New `SdkErrorCode` enum values:

- `SdkErrorCode.NotConnected` = `'NOT_CONNECTED'`
- `SdkErrorCode.AlreadyConnected` = `'ALREADY_CONNECTED'`
- `SdkErrorCode.NotInitialized` = `'NOT_INITIALIZED'`
- `SdkErrorCode.CapabilityNotSupported` = `'CAPABILITY_NOT_SUPPORTED'`
- `SdkErrorCode.RequestTimeout` = `'REQUEST_TIMEOUT'`
- `SdkErrorCode.ConnectionClosed` = `'CONNECTION_CLOSED'`
- `SdkErrorCode.SendFailed` = `'SEND_FAILED'`
- `SdkErrorCode.ClientHttpNotImplemented` = `'CLIENT_HTTP_NOT_IMPLEMENTED'`
- `SdkErrorCode.ClientHttpAuthentication` = `'CLIENT_HTTP_AUTHENTICATION'`
- `SdkErrorCode.ClientHttpForbidden` = `'CLIENT_HTTP_FORBIDDEN'`
- `SdkErrorCode.ClientHttpUnexpectedContent` = `'CLIENT_HTTP_UNEXPECTED_CONTENT'`
- `SdkErrorCode.ClientHttpFailedToOpenStream` = `'CLIENT_HTTP_FAILED_TO_OPEN_STREAM'`
- `SdkErrorCode.ClientHttpFailedToTerminateSession` = `'CLIENT_HTTP_FAILED_TO_TERMINATE_SESSION'`

Update error handling:

```typescript
// v1
if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) { ... }

// v2
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) { ... }
```

Update HTTP transport error handling:

```typescript
// v1
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
if (error instanceof StreamableHTTPError) {
    console.log('HTTP status:', error.code);
}

// v2
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
if (error instanceof SdkError && error.code === SdkErrorCode.ClientHttpFailedToOpenStream) {
    const status = (error.data as { status?: number })?.status;
}
```

### OAuth error consolidation

Individual OAuth error classes replaced with single `OAuthError` class and `OAuthErrorCode` enum:

| v1 Class                       | v2 Equivalent                                              |
| ------------------------------ | ---------------------------------------------------------- |
| `InvalidRequestError`          | `OAuthError` with `OAuthErrorCode.InvalidRequest`          |
| `InvalidClientError`           | `OAuthError` with `OAuthErrorCode.InvalidClient`           |
| `InvalidGrantError`            | `OAuthError` with `OAuthErrorCode.InvalidGrant`            |
| `UnauthorizedClientError`      | `OAuthError` with `OAuthErrorCode.UnauthorizedClient`      |
| `UnsupportedGrantTypeError`    | `OAuthError` with `OAuthErrorCode.UnsupportedGrantType`    |
| `InvalidScopeError`            | `OAuthError` with `OAuthErrorCode.InvalidScope`            |
| `AccessDeniedError`            | `OAuthError` with `OAuthErrorCode.AccessDenied`            |
| `ServerError`                  | `OAuthError` with `OAuthErrorCode.ServerError`             |
| `TemporarilyUnavailableError`  | `OAuthError` with `OAuthErrorCode.TemporarilyUnavailable`  |
| `UnsupportedResponseTypeError` | `OAuthError` with `OAuthErrorCode.UnsupportedResponseType` |
| `UnsupportedTokenTypeError`    | `OAuthError` with `OAuthErrorCode.UnsupportedTokenType`    |
| `InvalidTokenError`            | `OAuthError` with `OAuthErrorCode.InvalidToken`            |
| `MethodNotAllowedError`        | `OAuthError` with `OAuthErrorCode.MethodNotAllowed`        |
| `TooManyRequestsError`         | `OAuthError` with `OAuthErrorCode.TooManyRequests`         |
| `InvalidClientMetadataError`   | `OAuthError` with `OAuthErrorCode.InvalidClientMetadata`   |
| `InsufficientScopeError`       | `OAuthError` with `OAuthErrorCode.InsufficientScope`       |
| `InvalidTargetError`           | `OAuthError` with `OAuthErrorCode.InvalidTarget`           |
| `CustomOAuthError`             | `new OAuthError(customCode, message)`                      |

Removed: `OAUTH_ERRORS` constant.

Update OAuth error handling:

```typescript
// v1
import { InvalidClientError, InvalidGrantError } from '@modelcontextprotocol/client';
if (error instanceof InvalidClientError) { ... }

// v2
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/client';
if (error instanceof OAuthError && error.code === OAuthErrorCode.InvalidClient) { ... }
```

**Unchanged APIs** (only import paths changed): `Client` constructor and most methods, `McpServer` constructor, `server.connect()`, `server.close()`, all client transports (`StreamableHTTPClientTransport`, `SSEClientTransport`, `StdioClientTransport`), `StdioServerTransport`, all
protocol **type** definitions, all callback return types. Note: `callTool()` and `request()` accept the result-schema parameter as a `@deprecated` overload (see section 11). Zod **schema constants** are available via the `@deprecated` `/zod-schemas` subpath (see section 5).

## 6. McpServer API Changes

The variadic `.tool()`, `.prompt()`, `.resource()` methods are `@deprecated` (still work; forward to `register*`). For a full migration, switch to the `register*` methods with a config object.

**IMPORTANT**: v2 requires schema objects implementing [Standard Schema](https://standardschema.dev/) — raw shapes like `{ name: z.string() }` are no longer supported. Wrap with `z.object()` (Zod v4), or use ArkType's `type({...})`, or Valibot. For raw JSON Schema, wrap with
`fromJsonSchema(schema)` from `@modelcontextprotocol/server` (validator defaults automatically; pass an explicit validator for custom configurations). Applies to `inputSchema`, `outputSchema`, and `argsSchema`.

### Tools

```typescript
// v1: server.tool(name, schema, callback) - raw shape worked
server.tool('greet', { name: z.string() }, async ({ name }) => {
    return { content: [{ type: 'text', text: `Hello, ${name}!` }] };
});

// v1: server.tool(name, description, schema, callback)
server.tool('greet', 'Greet a user', { name: z.string() }, async ({ name }) => {
    return { content: [{ type: 'text', text: `Hello, ${name}!` }] };
});

// v2: server.registerTool(name, config, callback)
server.registerTool(
    'greet',
    {
        description: 'Greet a user',
        inputSchema: z.object({ name: z.string() })
    },
    async ({ name }) => {
        return { content: [{ type: 'text', text: `Hello, ${name}!` }] };
    }
);
```

Config object fields: `title?`, `description?`, `inputSchema?`, `outputSchema?`, `annotations?`, `_meta?`

### Prompts

```typescript
// v1: server.prompt(name, schema, callback) - raw shape worked
server.prompt('summarize', { text: z.string() }, async ({ text }) => {
    return { messages: [{ role: 'user', content: { type: 'text', text } }] };
});

// v2: server.registerPrompt(name, config, callback)
server.registerPrompt(
    'summarize',
    {
        argsSchema: z.object({ text: z.string() })
    },
    async ({ text }) => {
        return { messages: [{ role: 'user', content: { type: 'text', text } }] };
    }
);
```

Config object fields: `title?`, `description?`, `argsSchema?`

### Resources

```typescript
// v1: server.resource(name, uri, callback)
server.resource('config', 'config://app', async uri => {
    return { contents: [{ uri: uri.href, text: '{}' }] };
});

// v2: server.registerResource(name, uri, metadata, callback)
server.registerResource('config', 'config://app', {}, async uri => {
    return { contents: [{ uri: uri.href, text: '{}' }] };
});
```

Note: the third argument (`metadata`) is required — pass `{}` if no metadata.

### Schema Migration Quick Reference

| v1 (raw shape)                     | v2 (Standard Schema object)                  |
| ---------------------------------- | -------------------------------------------- |
| `{ name: z.string() }`             | `z.object({ name: z.string() })`             |
| `{ count: z.number().optional() }` | `z.object({ count: z.number().optional() })` |
| `{}` (empty)                       | `z.object({})`                               |
| `undefined` (no schema)            | `undefined` or omit the field                |

### Deprecated core exports

| v1 export (`@deprecated`)                                                            | Replacement                               |
| ------------------------------------------------------------------------------------ | ----------------------------------------- |
| `schemaToJson(schema)`                                                               | `standardSchemaToJsonSchema(schema)`      |
| `parseSchemaAsync(schema, data)`                                                     | `validateStandardSchema(schema, data)`    |
| `SchemaInput<T>`                                                                     | `StandardSchemaWithJSON.InferInput<T>`    |
| `getSchemaShape`, `getSchemaDescription`, `isOptionalSchema`, `unwrapOptionalSchema` | none (internal Zod introspection helpers) |

## 7. Headers API

Transport constructors now use the Web Standard `Headers` object instead of plain objects. The custom `RequestInfo` type has been replaced with the standard Web `Request` object, giving access to headers, URL, query parameters, and method.

```typescript
// v1: plain object, bracket access, custom RequestInfo
headers: { 'Authorization': 'Bearer token' }
extra.requestInfo?.headers['mcp-session-id']

// v2: Headers object, .get() access, standard Web Request
headers: new Headers({ 'Authorization': 'Bearer token' })
ctx.http?.req?.headers.get('mcp-session-id')
new URL(ctx.http?.req?.url).searchParams.get('debug')
```

## 8. Relocated Server Features

### SSE server transport

`SSEServerTransport` is `@deprecated` and now lives under `@modelcontextprotocol/node/sse`. Prefer `NodeStreamableHTTPServerTransport` (from `@modelcontextprotocol/node`). Client-side `SSEClientTransport` still available for connecting to legacy servers.

### Server-side auth

Server OAuth has been split: Resource-Server helpers (`requireBearerAuth`, `mcpAuthMetadataRouter`, `getOAuthProtectedResourceMetadataUrl`, `OAuthTokenVerifier`) are now first-class in `@modelcontextprotocol/express`. The Authorization-Server implementation (`mcpAuthRouter`, `ProxyOAuthServerProvider`, `authenticateClient`, etc.) moved to the frozen `@modelcontextprotocol/server-auth-legacy` package — prefer an external IdP for new code. See
`examples/server/src/` for demos.

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

| v1 Schema                               | v2 Method String                         |
| --------------------------------------- | ---------------------------------------- |
| `InitializeRequestSchema`               | `'initialize'`                           |
| `CallToolRequestSchema`                 | `'tools/call'`                           |
| `ListToolsRequestSchema`                | `'tools/list'`                           |
| `ListPromptsRequestSchema`              | `'prompts/list'`                         |
| `GetPromptRequestSchema`                | `'prompts/get'`                          |
| `ListResourcesRequestSchema`            | `'resources/list'`                       |
| `ReadResourceRequestSchema`             | `'resources/read'`                       |
| `CreateMessageRequestSchema`            | `'sampling/createMessage'`               |
| `ElicitRequestSchema`                   | `'elicitation/create'`                   |
| `SetLevelRequestSchema`                 | `'logging/setLevel'`                     |
| `PingRequestSchema`                     | `'ping'`                                 |
| `LoggingMessageNotificationSchema`      | `'notifications/message'`                |
| `ToolListChangedNotificationSchema`     | `'notifications/tools/list_changed'`     |
| `ResourceListChangedNotificationSchema` | `'notifications/resources/list_changed'` |
| `PromptListChangedNotificationSchema`   | `'notifications/prompts/list_changed'`   |
| `ProgressNotificationSchema`            | `'notifications/progress'`               |
| `CancelledNotificationSchema`           | `'notifications/cancelled'`              |
| `RootsListChangedNotificationSchema`    | `'notifications/roots/list_changed'`     |
| `ListRootsRequestSchema`                | `'roots/list'`                           |
| `CompleteRequestSchema`                 | `'completion/complete'`                  |
| `SubscribeRequestSchema`                | `'resources/subscribe'`                  |
| `UnsubscribeRequestSchema`              | `'resources/unsubscribe'`                |
| `ListResourceTemplatesRequestSchema`    | `'resources/templates/list'`             |
| `GetTaskRequestSchema`                  | `'tasks/get'`                            |
| `GetTaskPayloadRequestSchema`           | `'tasks/result'`                         |
| `ElicitationCompleteNotificationSchema` | `'notifications/elicitation/complete'`   |
| `InitializedNotificationSchema`         | `'notifications/initialized'`            |

Request/notification params remain fully typed. Remove unused schema imports after migration.

For **vendor-prefixed custom methods**, pass an explicit schema as the second argument: `server.setNotificationHandler('x-myorg/heartbeat', z.object({...}), handler)`. Do **not** add custom params to a spec method name — v2 validates against the spec schema and strips unknown
fields.

## 10. Request Handler Context Types

`RequestHandlerExtra` → structured context types with nested groups. Rename `extra` → `ctx` in all handler callbacks.

| v1                               | v2                                                                         |
| -------------------------------- | -------------------------------------------------------------------------- |
| `RequestHandlerExtra`            | `ServerContext` (server) / `ClientContext` (client) / `BaseContext` (base) |
| `extra` (param name)             | `ctx`                                                                      |
| `extra.signal`                   | `ctx.mcpReq.signal`                                                        |
| `extra.requestId`                | `ctx.mcpReq.id`                                                            |
| `extra._meta`                    | `ctx.mcpReq._meta`                                                         |
| `extra.sendRequest(...)`         | `ctx.mcpReq.send(...)`                                                     |
| `extra.sendNotification(...)`    | `ctx.mcpReq.notify(...)`                                                   |
| `extra.authInfo`                 | `ctx.http?.authInfo`                                                       |
| `extra.sessionId`                | `ctx.sessionId`                                                            |
| `extra.requestInfo`              | `ctx.http?.req` (standard Web `Request`, only `ServerContext`)             |
| `extra.closeSSEStream`           | `ctx.http?.closeSSE` (only `ServerContext`)                                |
| `extra.closeStandaloneSSEStream` | `ctx.http?.closeStandaloneSSE` (only `ServerContext`)                      |
| `extra.taskStore`                | `ctx.task?.store`                                                          |
| `extra.taskId`                   | `ctx.task?.id`                                                             |
| `extra.taskRequestedTtl`         | `ctx.task?.requestedTtl`                                                   |

`ServerContext` convenience methods (new in v2, no v1 equivalent):

| Method                                         | Description                                            | Replaces                                             |
| ---------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------- |
| `ctx.mcpReq.log(level, data, logger?)`         | Send log notification (respects client's level filter) | `server.sendLoggingMessage(...)` from within handler |
| `ctx.mcpReq.elicitInput(params, options?)`     | Elicit user input (form or URL)                        | `server.elicitInput(...)` from within handler        |
| `ctx.mcpReq.requestSampling(params, options?)` | Request LLM sampling from client                       | `server.createMessage(...)` from within handler      |

## 11. Schema parameter on `request()` and `callTool()` is now optional (`@deprecated`)

`Protocol.request()`, `BaseContext.mcpReq.send()`, and `Client.callTool()` still accept a result schema argument, but for spec methods it is optional — the SDK resolves the schema internally from the method name. The schema argument remains the supported form for custom (non-spec) methods. `client.experimental.tasks.callToolStream()` no longer takes a schema argument.

```typescript
// v1: schema required
import { CallToolResultSchema, ElicitResultSchema } from '@modelcontextprotocol/sdk/types.js';
const result = await client.request({ method: 'tools/call', params: { ... } }, CallToolResultSchema);
const elicit = await ctx.mcpReq.send({ method: 'elicitation/create', params: { ... } }, ElicitResultSchema);
const tool = await client.callTool({ name: 'my-tool', arguments: {} }, CompatibilityCallToolResultSchema);

// v2: schema optional for spec methods
const result = await client.request({ method: 'tools/call', params: { ... } });
const elicit = await ctx.mcpReq.send({ method: 'elicitation/create', params: { ... } });
const tool = await client.callTool({ name: 'my-tool', arguments: {} });
```

| v1 call                                                                    | v2 call                                                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `client.request(req, ResultSchema)`                                        | `client.request(req)`                                        |
| `client.request(req, ResultSchema, options)`                               | `client.request(req, options)`                               |
| `client.experimental.tasks.callToolStream(params, ResultSchema, options?)` | `client.experimental.tasks.callToolStream(params, options?)` |
| `ctx.mcpReq.send(req, ResultSchema)`                                       | `ctx.mcpReq.send(req)`                                       |
| `ctx.mcpReq.send(req, ResultSchema, options)`                              | `ctx.mcpReq.send(req, options)`                              |
| `client.callTool(params, CompatibilityCallToolResultSchema)`               | `client.callTool(params)`                                    |
| `client.callTool(params, schema, options)`                                 | `client.callTool(params, options)`                           |

Remove unused schema imports: `CallToolResultSchema`, `CompatibilityCallToolResultSchema`, `ElicitResultSchema`, `CreateMessageResultSchema`, etc., when they were only used in `request()`/`send()`/`callTool()` calls.

If `CallToolResultSchema` was used for **runtime validation** (not just as a `request()` argument), replace with the `isCallToolResult` type guard:

| v1 pattern                                      | v2 replacement                                                        |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| `CallToolResultSchema.safeParse(value).success` | `isCallToolResult(value)`                                             |
| `CallToolResultSchema.parse(value)`             | Use `isCallToolResult(value)` then cast, or use `CallToolResult` type |

## 12. Experimental: `TaskCreationParams.ttl` no longer accepts `null`

`TaskCreationParams.ttl` changed from `z.union([z.number(), z.null()]).optional()` to `z.number().optional()`. Per the MCP spec, `null` TTL (unlimited lifetime) is only valid in server responses (`Task.ttl`), not in client requests. Omit `ttl` to let the server decide.

| v1                     | v2                                 |
| ---------------------- | ---------------------------------- |
| `task: { ttl: null }`  | `task: {}` (omit ttl)              |
| `task: { ttl: 60000 }` | `task: { ttl: 60000 }` (unchanged) |

Type changes in handler context:

| Type                                        | v1                            | v2                    |
| ------------------------------------------- | ----------------------------- | --------------------- |
| `TaskContext.requestedTtl`                  | `number \| null \| undefined` | `number \| undefined` |
| `CreateTaskServerContext.task.requestedTtl` | `number \| null \| undefined` | `number \| undefined` |
| `TaskServerContext.task.requestedTtl`       | `number \| null \| undefined` | `number \| undefined` |

> These task APIs are `@experimental` and may change without notice.

## 13. Client Behavioral Changes

`Client.listPrompts()`, `listResources()`, `listResourceTemplates()`, `listTools()` now return empty results when the server lacks the corresponding capability (instead of sending the request). Set `enforceStrictCapabilities: true` in `ClientOptions` to throw an error instead.

## 14. Runtime-Specific JSON Schema Validators (Enhancement)

The SDK now auto-selects the appropriate JSON Schema validator based on runtime:

- Node.js → `AjvJsonSchemaValidator` (no change from v1)
- Cloudflare Workers (workerd) → `CfWorkerJsonSchemaValidator` (previously required manual config)

**No action required** for most users. Cloudflare Workers users can remove explicit `jsonSchemaValidator` configuration:

```typescript
// v1 (Cloudflare Workers): Required explicit validator
new McpServer(
    { name: 'server', version: '1.0.0' },
    {
        jsonSchemaValidator: new CfWorkerJsonSchemaValidator()
    }
);

// v2 (Cloudflare Workers): Auto-selected, explicit config optional
new McpServer({ name: 'server', version: '1.0.0' }, {});
```

Access validators via `_shims` export: `import { DefaultJsonSchemaValidator } from '@modelcontextprotocol/server/_shims';`

## 15. Migration Steps (apply in this order)

0. **Shortest path:** bump `@modelcontextprotocol/sdk` to `^2.0.0`, ensure `zod@^4.2.0` and `moduleResolution: bundler|nodenext`, run the build. If it passes, you are on v2; any IDE-flagged `@deprecated` usages are optional follow-ups. Stop here unless a full migration is requested.
1. Update `package.json`: `npm uninstall @modelcontextprotocol/sdk`, install the appropriate v2 packages
2. Replace all imports from `@modelcontextprotocol/sdk/...` using the import mapping tables (sections 3-4), including `StreamableHTTPServerTransport` → `NodeStreamableHTTPServerTransport`
3. Replace `@deprecated` type aliases (`JSONRPCError` → `JSONRPCErrorResponse`, etc.) per section 5
4. Replace `.tool()` / `.prompt()` / `.resource()` calls with `registerTool` / `registerPrompt` / `registerResource` per section 6
5. **Wrap all raw Zod shapes with `z.object()`**: Change `inputSchema: { name: z.string() }` → `inputSchema: z.object({ name: z.string() })`. Same for `outputSchema` in tools and `argsSchema` in prompts.
6. Replace plain header objects with `new Headers({...})` and bracket access (`headers['x']`) with `.get()` calls per section 7
7. If using `hostHeaderValidation` from server, update import and signature per section 8
8. If using server SSE transport, migrate to Streamable HTTP
9. If using server auth from the SDK, migrate to an external auth library
10. If relying on `listTools()`/`listPrompts()`/etc. throwing on missing capabilities, set `enforceStrictCapabilities: true`
11. Verify: build with `tsc` / run tests
