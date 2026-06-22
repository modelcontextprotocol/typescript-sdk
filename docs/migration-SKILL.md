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

| You need              | Install                                                                  |
| --------------------- | ------------------------------------------------------------------------ |
| Client only           | `npm install @modelcontextprotocol/client`                               |
| Server only           | `npm install @modelcontextprotocol/server`                               |
| Server + Node.js HTTP | `npm install @modelcontextprotocol/server @modelcontextprotocol/node`    |
| Server + Express      | `npm install @modelcontextprotocol/server @modelcontextprotocol/express` |
| Server + Hono         | `npm install @modelcontextprotocol/server @modelcontextprotocol/hono`    |

`@modelcontextprotocol/core` is installed automatically as a dependency.

## 3. Import Mapping

Replace all `@modelcontextprotocol/sdk/...` imports using this table.

### Client imports

| v1 import path                                       | v2 package                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| `@modelcontextprotocol/sdk/client/index.js`          | `@modelcontextprotocol/client`                                                 |
| `@modelcontextprotocol/sdk/client/auth.js`           | `@modelcontextprotocol/client`                                                 |
| `@modelcontextprotocol/sdk/client/streamableHttp.js` | `@modelcontextprotocol/client`                                                 |
| `@modelcontextprotocol/sdk/client/sse.js`            | `@modelcontextprotocol/client`                                                 |
| `@modelcontextprotocol/sdk/client/stdio.js`          | `@modelcontextprotocol/client/stdio`                                           |
| `@modelcontextprotocol/sdk/client/websocket.js`      | REMOVED (use Streamable HTTP or stdio; implement `Transport` for custom needs) |

### Server imports

| v1 import path                                       | v2 package                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@modelcontextprotocol/sdk/server/mcp.js`            | `@modelcontextprotocol/server`                                                                                                                                                                                                                                                      |
| `@modelcontextprotocol/sdk/server/index.js`          | `@modelcontextprotocol/server`                                                                                                                                                                                                                                                      |
| `@modelcontextprotocol/sdk/server/stdio.js`          | `@modelcontextprotocol/server/stdio`                                                                                                                                                                                                                                                |
| `@modelcontextprotocol/sdk/server/streamableHttp.js` | `@modelcontextprotocol/node` (class renamed to `NodeStreamableHTTPServerTransport`) OR `@modelcontextprotocol/server` (web-standard `WebStandardStreamableHTTPServerTransport` for Cloudflare Workers, Deno, etc.)                                                                  |
| `@modelcontextprotocol/sdk/server/sse.js`            | REMOVED (migrate to Streamable HTTP); legacy bridge: `@modelcontextprotocol/server-legacy/sse`                                                                                                                                                                                      |
| `@modelcontextprotocol/sdk/server/auth/*`            | RS helpers (`requireBearerAuth`, `mcpAuthMetadataRouter`, `OAuthTokenVerifier`) → `@modelcontextprotocol/express`; AS helpers (`mcpAuthRouter`, `OAuthServerProvider`, etc.) → `@modelcontextprotocol/server-legacy/auth` (deprecated); migrate AS to an external IdP/OAuth library |
| `@modelcontextprotocol/sdk/server/middleware.js`     | `@modelcontextprotocol/express` (signature changed, see section 8)                                                                                                                                                                                                                  |

### Types / shared imports

| v1 import path                                    | v2 package                                                                                                                                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@modelcontextprotocol/sdk/types.js`              | `@modelcontextprotocol/client` or `@modelcontextprotocol/server`                                                                                                                                     |
| `@modelcontextprotocol/sdk/shared/protocol.js`    | `@modelcontextprotocol/client` or `@modelcontextprotocol/server`                                                                                                                                     |
| `@modelcontextprotocol/sdk/shared/transport.js`   | `@modelcontextprotocol/client` or `@modelcontextprotocol/server`                                                                                                                                     |
| `@modelcontextprotocol/sdk/shared/uriTemplate.js` | `@modelcontextprotocol/client` or `@modelcontextprotocol/server`                                                                                                                                     |
| `@modelcontextprotocol/sdk/shared/auth.js`        | `@modelcontextprotocol/client` or `@modelcontextprotocol/server`                                                                                                                                     |
| `@modelcontextprotocol/sdk/shared/stdio.js`       | `@modelcontextprotocol/client` or `@modelcontextprotocol/server` (`ReadBuffer`, `serializeMessage`, `deserializeMessage` are in the root barrel; the `./stdio` subpath only has the transport class) |

Notes:

- `@modelcontextprotocol/client` and `@modelcontextprotocol/server` both re-export shared types from `@modelcontextprotocol/core`, so import from whichever package you already depend on. Do not import from `@modelcontextprotocol/core` directly — it is an internal package.
- When multiple v1 imports map to the same v2 package, consolidate them into a single import statement.

## 4. Renamed Symbols

| v1 symbol                       | v2 symbol                           | v2 package                   |
| ------------------------------- | ----------------------------------- | ---------------------------- |
| `StreamableHTTPServerTransport` | `NodeStreamableHTTPServerTransport` | `@modelcontextprotocol/node` |

## 5. Removed / Renamed Type Aliases and Symbols

| v1 (removed)                             | v2 (replacement)                                                                                                |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `JSONRPCError`                           | `JSONRPCErrorResponse`                                                                                          |
| `JSONRPCErrorSchema`                     | `JSONRPCErrorResponseSchema`                                                                                    |
| `isJSONRPCError`                         | `isJSONRPCErrorResponse`                                                                                        |
| `isJSONRPCResponse` (deprecated in v1)   | `isJSONRPCResultResponse` (**not** v2's new `isJSONRPCResponse`, which correctly matches both result and error) |
| `ResourceReference`                      | `ResourceTemplateReference`                                                                                     |
| `ResourceReferenceSchema`                | `ResourceTemplateReferenceSchema`                                                                               |
| `IsomorphicHeaders`                      | REMOVED (use Web Standard `Headers`)                                                                            |
| `AuthInfo` (from `server/auth/types.js`) | `AuthInfo` (now re-exported by `@modelcontextprotocol/client` and `@modelcontextprotocol/server`)               |
| `McpError`                               | `ProtocolError`                                                                                                 |
| `ErrorCode`                              | `ProtocolErrorCode`                                                                                             |
| `ErrorCode.RequestTimeout`               | `SdkErrorCode.RequestTimeout`                                                                                   |
| `ErrorCode.ConnectionClosed`             | `SdkErrorCode.ConnectionClosed`                                                                                 |
| `StreamableHTTPError`                    | REMOVED (use `SdkHttpError` with `SdkErrorCode.ClientHttp*`)                                                    |
| `WebSocketClientTransport`               | REMOVED (use `StreamableHTTPClientTransport` or `StdioClientTransport`)                                         |

All other **type** symbols from `@modelcontextprotocol/sdk/types.js` retain their original names. **Zod schemas** (e.g., `CallToolResultSchema`, `ListToolsResultSchema`) are no longer part of the public API — they are internal to the SDK. For runtime validation, use
`isSpecType.TypeName(value)` (e.g., `isSpecType.CallToolResult(v)`) or `specTypeSchemas.TypeName` for the `StandardSchemaV1Sync` validator object. The keys are typed as `SpecTypeName`, a literal union of all spec type names.

### Error class changes

Three error classes now exist:

- **`ProtocolError`** (renamed from `McpError`): Protocol errors that cross the wire as JSON-RPC responses
- **`SdkError`** (new): Local SDK errors that never cross the wire
- **`SdkHttpError`** (extends `SdkError`): HTTP transport errors with typed `.status` and `.statusText` accessors

| Error scenario                    | v1 type                                      | v2 type                                                               |
| --------------------------------- | -------------------------------------------- | --------------------------------------------------------------------- |
| Request timeout                   | `McpError` with `ErrorCode.RequestTimeout`   | `SdkError` with `SdkErrorCode.RequestTimeout`                         |
| Connection closed                 | `McpError` with `ErrorCode.ConnectionClosed` | `SdkError` with `SdkErrorCode.ConnectionClosed`                       |
| Capability not supported          | `new Error(...)`                             | `SdkError` with `SdkErrorCode.CapabilityNotSupported`                 |
| Not connected                     | `new Error('Not connected')`                 | `SdkError` with `SdkErrorCode.NotConnected`                           |
| Invalid params (server response)  | `McpError` with `ErrorCode.InvalidParams`    | `ProtocolError` with `ProtocolErrorCode.InvalidParams`                |
| HTTP transport error (legacy era) | `StreamableHTTPError`                        | `SdkHttpError` with `SdkErrorCode.ClientHttp*`                        |
| Failed to open SSE stream         | `StreamableHTTPError`                        | `SdkHttpError` with `SdkErrorCode.ClientHttpFailedToOpenStream`       |
| 401 after re-auth (circuit break) | `StreamableHTTPError`                        | `SdkHttpError` with `SdkErrorCode.ClientHttpAuthentication`           |
| 403 insufficient_scope after step-up retry cap | `StreamableHTTPError`           | `SdkHttpError` with `SdkErrorCode.ClientHttpForbidden`                |
| Unexpected content type           | `StreamableHTTPError`                        | `SdkError` with `SdkErrorCode.ClientHttpUnexpectedContent`            |
| Session termination failed        | `StreamableHTTPError`                        | `SdkHttpError` with `SdkErrorCode.ClientHttpFailedToTerminateSession` |
| Response result fails schema      | `ZodError` (raw)                             | `SdkError` with `SdkErrorCode.InvalidResult`                          |

**Modern-era exception** to the `SdkHttpError` rows above: on a modern-enveloped (2026-07-28) Streamable HTTP request, an HTTP `400` whose body is a well-formed JSON-RPC error response addressed to the pending request id is delivered in-band as a `ProtocolError` (e.g. `-32020`
HeaderMismatch from a SEP-2243 `Mcp-Param-*` rejection), not as `SdkHttpError`. Legacy-era exchanges and generic HTTP failures are unchanged.

New `SdkErrorCode` enum values:

- `SdkErrorCode.NotConnected` = `'NOT_CONNECTED'`
- `SdkErrorCode.AlreadyConnected` = `'ALREADY_CONNECTED'`
- `SdkErrorCode.NotInitialized` = `'NOT_INITIALIZED'`
- `SdkErrorCode.CapabilityNotSupported` = `'CAPABILITY_NOT_SUPPORTED'`
- `SdkErrorCode.RequestTimeout` = `'REQUEST_TIMEOUT'`
- `SdkErrorCode.ConnectionClosed` = `'CONNECTION_CLOSED'`
- `SdkErrorCode.SendFailed` = `'SEND_FAILED'`
- `SdkErrorCode.InvalidResult` = `'INVALID_RESULT'`
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
import { SdkHttpError, SdkErrorCode } from '@modelcontextprotocol/client';
if (error instanceof SdkHttpError) {
    console.log('HTTP status:', error.status); // number — typed accessor
    console.log('Status text:', error.statusText); // string | undefined
    switch (error.code) {
        case SdkErrorCode.ClientHttpAuthentication: // 401 after re-auth
        case SdkErrorCode.ClientHttpForbidden: // 403 insufficient_scope after step-up retry cap
        case SdkErrorCode.ClientHttpFailedToOpenStream:
        case SdkErrorCode.ClientHttpNotImplemented:
            break;
    }
}
// Modern-era (2026-07-28) only: a 400 carrying a JSON-RPC error body addressed
// to the pending request id surfaces as ProtocolError, NOT SdkHttpError — e.g.
// a SEP-2243 -32020 HeaderMismatch from createMcpHandler. Legacy-era 400s and
// generic HTTP failures still map to SdkHttpError above.
if (error instanceof ProtocolError) {
    console.log('In-band JSON-RPC error:', error.code);
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
| `InsufficientScopeError`       | `OAuthError` with `OAuthErrorCode.InsufficientScope` ¹     |
| `InvalidTargetError`           | `OAuthError` with `OAuthErrorCode.InvalidTarget`           |
| `CustomOAuthError`             | `new OAuthError(customCode, message)`                      |

¹ v1 server-side OAuth error only. The new transport-layer `InsufficientScopeError` exported from `@modelcontextprotocol/client` for SEP-2350 (RFC 6750 challenge from the resource server) is a DIFFERENT class, extends `OAuthClientFlowError` not `OAuthError`, and MUST NOT be rewritten by this row.

Removed: `OAUTH_ERRORS` constant.

The OAuth client flow additionally throws dedicated classes from `@modelcontextprotocol/client` (all extend `OAuthClientFlowError`, **not** `OAuthError` — `auth()`'s `OAuthError` retry path will not catch them). SEP-2350 adds `InsufficientScopeError` to this set; see the migration guide's [Scope step-up section](./migration.md#scope-step-up-on-403-insufficient_scope-sep-2350).

| Throw site                                                                                                     | v2 class                                                            |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `registerClient()` rejected by AS (any RFC 7591 error incl. `invalid_client_metadata`, `invalid_redirect_uri`) | `RegistrationRejectedError` (`status`, `body`, `submittedMetadata`) |
| `exchangeAuthorization()` / `refreshAuthorization()` / `fetchToken()` / `requestJwtAuthorizationGrant()` / `exchangeJwtAuthGrant()` non-https token endpoint | `InsecureTokenEndpointError` (`tokenEndpoint`)                      |
| RFC 9207 `iss` mismatch / RFC 8414 §3.3 issuer-echo mismatch                                                   | `IssuerMismatchError` (`kind`, `expected`, `received`)              |
| Transport 403 `insufficient_scope` with `onInsufficientScope: 'throw'`, or default mode without an `OAuthClientProvider` | `InsufficientScopeError` (`requiredScope`, `resourceMetadataUrl`, `errorDescription`) |

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
Zod schemas, all callback return types. Note: `callTool()` and `request()` signatures changed (schema parameter removed, see section 11).

## 6. McpServer API Changes

The variadic `.tool()`, `.prompt()`, `.resource()` methods are removed. Use the `register*` methods with a config object.

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

### Removed core exports

| Removed from `@modelcontextprotocol/core`                                            | Replacement                               |
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

## 8. Removed Server Features

### SSE server transport

`SSEServerTransport` removed entirely. Migrate to `NodeStreamableHTTPServerTransport` (from `@modelcontextprotocol/node`). Client-side `SSEClientTransport` still available for connecting to legacy servers. Legacy bridge:
`import { SSEServerTransport } from '@modelcontextprotocol/server-legacy/sse'` (deprecated, frozen v1 copy).

### Server-side auth

Resource Server helpers (`requireBearerAuth`, `mcpAuthMetadataRouter`, `getOAuthProtectedResourceMetadataUrl`, `OAuthTokenVerifier`) are first-class in `@modelcontextprotocol/express`. Authorization Server helpers (`mcpAuthRouter`, `OAuthServerProvider`,
`ProxyOAuthServerProvider`, `authenticateClient`, `allowedMethods`, etc.) are available from `@modelcontextprotocol/server-legacy/auth` (deprecated, frozen v1 copy). Migrate AS to an external IdP/OAuth library for production use. See `examples/server/src/` for demos.

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

For custom (non-spec) methods, use the 3-arg form `(method, schemas, handler)`:

```typescript
// v1: Zod schema with method literal
server.setRequestHandler(z.object({ method: z.literal('acme/search'), params: P }), async req => { ... });

// v2: method string + schemas object; handler receives parsed params
server.setRequestHandler('acme/search', { params: P, result: R }, async (params, ctx) => { ... });
client.setNotificationHandler('acme/progress', { params: P }, (params, notification) => { ... });
```

The 3-arg notification handler receives the raw notification as its second argument, so `_meta` is recoverable via `notification.params?._meta`.

To send a custom-method request, pass a result schema as the second argument to `request()` (and `ctx.mcpReq.send()`):

```typescript
// v1
await client.request({ method: 'acme/search', params }, ResultSchema);
// v2 (unchanged; now any Standard Schema, not Zod-only)
await client.request({ method: 'acme/search', params }, ResultSchema);
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
| `InitializedNotificationSchema`         | `'notifications/initialized'`            |

Request/notification params remain fully typed. Remove unused schema imports after migration.

## 10. Request Handler Context Types

`RequestHandlerExtra` → structured context types with nested groups. Rename `extra` → `ctx` in all handler callbacks.

| v1                                                | v2                                                                         |
| ------------------------------------------------- | -------------------------------------------------------------------------- |
| `RequestHandlerExtra`                             | `ServerContext` (server) / `ClientContext` (client) / `BaseContext` (base) |
| `extra` (param name)                              | `ctx`                                                                      |
| `extra.signal`                                    | `ctx.mcpReq.signal`                                                        |
| `extra.requestId`                                 | `ctx.mcpReq.id`                                                            |
| `extra._meta`                                     | `ctx.mcpReq._meta`                                                         |
| `extra.sendRequest(...)`                          | `ctx.mcpReq.send(...)`                                                     |
| `extra.sendNotification(...)`                     | `ctx.mcpReq.notify(...)`                                                   |
| `extra.authInfo`                                  | `ctx.http?.authInfo`                                                       |
| `extra.sessionId`                                 | `ctx.sessionId`                                                            |
| `extra.requestInfo`                               | `ctx.http?.req` (standard Web `Request`, only `ServerContext`)             |
| `extra.closeSSEStream`                            | `ctx.http?.closeSSE` (only `ServerContext`)                                |
| `extra.closeStandaloneSSEStream`                  | `ctx.http?.closeStandaloneSSE` (only `ServerContext`)                      |
| `extra.taskStore` / `taskId` / `taskRequestedTtl` | _removed; see §12_                                                         |

`ServerContext` convenience methods (new in v2, no v1 equivalent):

| Method                                         | Description                                            | Replaces                                             |
| ---------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------- |
| `ctx.mcpReq.log(level, data, logger?)`         | Send log notification (respects client's level filter) | `server.sendLoggingMessage(...)` from within handler |
| `ctx.mcpReq.elicitInput(params, options?)`     | Elicit user input (form or URL)                        | `server.elicitInput(...)` from within handler        |
| `ctx.mcpReq.requestSampling(params, options?)` | Request LLM sampling from client                       | `server.createMessage(...)` from within handler      |

## 11. Schema parameter removed from `request()`, `send()`, and `callTool()` (spec methods)

For **spec** methods, `Protocol.request()`, `BaseContext.mcpReq.send()`, and `Client.callTool()` no longer require a Zod result schema argument. The SDK resolves the schema internally from the method name.

```typescript
// v1: schema required
import { CallToolResultSchema, ElicitResultSchema } from '@modelcontextprotocol/sdk/types.js';
const result = await client.request({ method: 'tools/call', params: { ... } }, CallToolResultSchema);
const elicit = await ctx.mcpReq.send({ method: 'elicitation/create', params: { ... } }, ElicitResultSchema);
const tool = await client.callTool({ name: 'my-tool', arguments: {} }, CompatibilityCallToolResultSchema);

// v2: no schema argument
const result = await client.request({ method: 'tools/call', params: { ... } });
const elicit = await ctx.mcpReq.send({ method: 'elicitation/create', params: { ... } });
const tool = await client.callTool({ name: 'my-tool', arguments: {} });
```

| v1 call                                                      | v2 call                            |
| ------------------------------------------------------------ | ---------------------------------- |
| `client.request(req, ResultSchema)`                          | `client.request(req)`              |
| `client.request(req, ResultSchema, options)`                 | `client.request(req, options)`     |
| `ctx.mcpReq.send(req, ResultSchema)`                         | `ctx.mcpReq.send(req)`             |
| `ctx.mcpReq.send(req, ResultSchema, options)`                | `ctx.mcpReq.send(req, options)`    |
| `client.callTool(params, CompatibilityCallToolResultSchema)` | `client.callTool(params)`          |
| `client.callTool(params, schema, options)`                   | `client.callTool(params, options)` |

For **custom (non-spec)** methods, keep the result-schema argument — see §9. Only apply the rewrites above when `req.method` is a spec method.

Remove unused schema imports: `CallToolResultSchema`, `CompatibilityCallToolResultSchema`, `ElicitResultSchema`, `CreateMessageResultSchema`, etc., when they were only used in `request()`/`send()`/`callTool()` calls.

If a `*Schema` constant was used for **runtime validation** (not just as a `request()` argument), replace with `isSpecType` / `specTypeSchemas`:

| v1 pattern                                         | v2 replacement                                                                                              |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `CallToolResultSchema.safeParse(value).success`    | `isSpecType.CallToolResult(value)`                                                                          |
| `<TypeName>Schema.safeParse(value).success`        | `isSpecType.<TypeName>(value)`                                                                              |
| `<TypeName>Schema.parse(value)`                    | `specTypeSchemas.<TypeName>['~standard'].validate(value)` (returns a `Result` synchronously, not the value) |
| Passing `<TypeName>Schema` as a validator argument | `specTypeSchemas.<TypeName>` (a `StandardSchemaV1Sync<In, Out>`)                                            |

`isCallToolResult(value)` still works, but `isSpecType` covers every spec type by name.

## 12. Experimental tasks interception removed

The 2025-11 task side-channel through `Protocol` is removed (was always `@experimental`). No mechanical migration; remove usages.

| Removed                                                                                                                                                                   | Notes                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `ProtocolOptions.tasks`                                                                                                                                                   | drop the option               |
| `protocol.taskManager`                                                                                                                                                    | gone                          |
| `RequestOptions.task` / `.relatedTask`, `NotificationOptions.relatedTask`                                                                                                 | drop the option               |
| `BaseContext.task` (`ctx.task?.*`)                                                                                                                                        | gone                          |
| `assertTaskCapability` / `assertTaskHandlerCapability` overrides                                                                                                          | delete the override           |
| `*.experimental.tasks.*` accessors, `Experimental{Client,Server,McpServer}Tasks`                                                                                          | removed                       |
| `requestStream` / `callToolStream` / `createMessageStream` / `elicitInputStream`                                                                                          | removed; no streaming variant |
| `registerToolTask`, `ToolTaskHandler`, `TaskRequestHandler`, `CreateTaskRequestHandler`                                                                                   | removed                       |
| `TaskMessageQueue`, `InMemoryTaskMessageQueue`, `BaseQueuedMessage`, `Queued*`, `CreateTaskServerContext`, `TaskServerContext`, `TaskToolExecution`                       | removed                       |
| `ResponseMessage`, `BaseResponseMessage`, `ErrorMessage`, `AsyncGeneratorValue`, `TaskStatusMessage`, `TaskCreatedMessage`, `ResultMessage`, `takeResult`, `toArrayAsync` | removed                       |

`TaskStore` / `InMemoryTaskStore` / `CreateTaskOptions` / `isTerminal` (storage layer) are also removed; they will return with the SEP-2663 server-directed plugin.

NOT removed (wire surface, kept for 2025-11-25 interop, now `@deprecated`): task Zod schemas + inferred types (`Task`, `TaskStatus`, `TaskMetadata`, `RelatedTaskMetadata`, `CreateTaskResult`, `GetTask*`, `ListTasks*`, `CancelTask*`, `TaskStatusNotification*`,
`TaskAugmentedRequestParams`), task members of the request/result/notification union types, the `tasks` capability key, `isTaskAugmentedRequestParams`, `RELATED_TASK_META_KEY`. Inbound `tasks/*` requests → `-32601`.

Task methods are excluded from the typed method maps: `RequestMethod`/`RequestTypeMap`/`ResultTypeMap` have no `tasks/*` entries and `NotificationMethod`/`NotificationTypeMap` have no `notifications/tasks/status`, so the method-keyed overloads of `request()`, `ctx.mcpReq.send()`,
`setRequestHandler()`, `setNotificationHandler()` reject task methods at compile time. Mechanical fix where task interop is genuinely required: pass an explicit schema (`request({ method: 'tasks/get', params }, GetTaskResultSchema)`-style custom-method form).
`ResultTypeMap['tools/call']` is plain `CallToolResult` (no `| CreateTaskResult`); same for `sampling/createMessage` and `elicitation/create`.

## 12b. Wire-only members hidden from public types

`resultType` (2026-07-28 result discrimination) is no longer declared on any public result type; the SDK parses and consumes it internally. The reserved `_meta` envelope keys (`io.modelcontextprotocol/{protocolVersion,clientInfo,clientCapabilities,logLevel}`) and retry fields
(`inputResponses`, `requestState`) appear in no public params/result type. `RequestMetaEnvelope` and the `*_META_KEY` constants remain exported.

v1 code never reads `resultType` (the field did not exist before 2026-07-28); the table below applies only to code that began reading the wire shape directly.

| Pattern                                | Mechanical fix                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| `result.resultType` (typed read)       | delete the read — the SDK consumes the field; results are complete when delivered |
| `Result['resultType']` type reference  | remove; the member is no longer declared                                          |
| return-type capture of `callTool` etc. | use the named public types (`CallToolResult`, `ListToolsResult`, …)               |

Runtime counterpart: inbound reserved envelope keys are lifted out of `params._meta` before handlers run — on requests they are readable at `ctx.mcpReq.envelope` (typed `Partial<RequestMetaEnvelope>`, keys present only as received); on notifications there is no ctx, so the lifted
envelope keys are dropped and NOT surfaced anywhere. Retry fields (`inputResponses`/`requestState`) lift from REQUEST top-level params only, to `ctx.mcpReq.inputResponses` / `ctx.mcpReq.requestState`; notification params are never touched. On a 2026-era exchange a response
carrying a non-`complete` `resultType` rejects with `SdkError` code `UNSUPPORTED_RESULT_TYPE` (kind in `error.data.resultType`), while on a 2025-era connection a foreign `resultType` is stripped before validation; the serving wire era is the instance's negotiated protocol version
(connection state), and `MessageExtraInfo.classification` is only validated against it at dispatch (a mismatch is rejected as an entry/routing error). Collision note for 2025-era peers: 2025-11-25 reserves the `io.modelcontextprotocol/` `_meta` prefix but NOT the bare names
`inputResponses`/`requestState`, so a 2025 peer's custom-method request using those names as ordinary params has them lifted out of `request.params` (recoverable via ctx; everything else passes through untouched).

## 12c. Per-era wire codecs (physical deletions + stricter wire schemas)

The wire layer is split into per-era codecs (2025-era = 2024-10-07 … 2025-11-25; 2026-era = 2026-07-28). Era-mismatched spec methods fail physically: inbound -> `-32601` even with a handler registered; outbound -> `SdkError` code `METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION` before
the transport.

| v1 pattern                                                                                 | Mechanical fix                                                                                             |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| tool handler returns without `content`                                                     | add `content: []` (or real content) — results without it are rejected `-32602`, no longer defaulted        |
| parsing wire bytes with `EmptyResultSchema` that may carry `resultType`                    | strip `resultType` first (the schema now rejects it as an unknown key)                                     |
| strict custom-handler params schema (3-arg `setRequestHandler`/`setNotification…`)         | add optional `_meta` to the schema (or strip it) — `_meta` is now passed through minus reserved keys       |
| `specTypeSchemas`/`SpecTypeName` references to task message types or `RequestMetaEnvelope` | remove — these validators left the public set (types remain importable)                                    |
| `ClientRequest`/`ServerResult`/… aggregate types expected to include task members          | use the individual deprecated `Task*` types — role aggregates are now the neutral (task-free) sets         |
| relying on `isCallToolResult` to reject wire-only members                                  | guards validate neutral shapes (loose passthrough); validate raw wire traffic with a transport-level parse |

## 12d. Multi round-trip requests (2026-07-28)

The 2026-07-28 revision removes the server→client JSON-RPC request channel; servers obtain client input in-band by returning `inputRequired(...)` from a `tools/call`/`prompts/get`/`resources/read` handler, and the client's auto-fulfilment driver retries the original call.

| v1 pattern (handler serving 2026-07-28 requests)                              | Mechanical fix                                                                                                                                    |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `await ctx.mcpReq.elicitInput({…})` / `requestSampling({…})` inside a handler | `return inputRequired({ inputRequests: { id: inputRequired.elicit({…}) } })`; read `acceptedContent(ctx.mcpReq.inputResponses, 'id')` on re-entry |
| `throw new UrlElicitationRequiredError([…])`                                  | `return inputRequired({ inputRequests: { id: inputRequired.elicitUrl({…}) } })`                                                                   |
| handler shared across both eras                                               | branch on the served era: keep the v1 push-style call toward 2025-era requests, return `inputRequired(...)` toward 2026-07-28 requests            |

`inputRequired`/`acceptedContent`/`InputRequiredSpec` are exported from `@modelcontextprotocol/server`. `requestState` round-trips as an opaque string and comes back as attacker-controlled input — integrity-protect (HMAC/AEAD) and verify it yourself when relying on it, or drop the SDK's `createRequestStateCodec({ key, ttlSeconds?, bind? })` into `ServerOptions.requestState.verify` (mint with `codec.mint`, decode on re-entry with `codec.verify`). Client
side: auto-fulfilment is on by default (`ClientOptions.inputRequired`, `maxRounds` cap default 10); manual mode is `inputRequired: { autoFulfill: false }` plus per-call `allowInputRequired: true` and `withInputRequired(schema)`.

## 13. Behavioral Changes

### Client

`Client.listPrompts()`, `listResources()`, `listResourceTemplates()`, `listTools()` now return empty results when the server lacks the corresponding capability (instead of sending the request). Set `enforceStrictCapabilities: true` in `ClientOptions` to throw an error instead.

`Client.listTools()`, `listPrompts()`, `listResources()`, `listResourceTemplates()` called without a `cursor` now auto-aggregate every page and return the complete result (`nextCursor: undefined`); an explicit `{ cursor }` string still returns one page. Manual `do { … } while (cursor !== undefined)` loops keep working (the first call returns everything and the loop exits after one iteration) — replace them with the bare no-arg call. New `ClientOptions.listMaxPages` (default 64) caps the aggregate walk only; overrun throws `SdkError` (`SdkErrorCode.ListPaginationExceeded`).

`Client.listTools()` / `listPrompts()` / `listResources()` / `listResourceTemplates()` / `readResource()` now honour the server-stamped SEP-2549 `ttlMs`/`cacheScope`: a still-fresh cached entry is returned without a round trip. Opt-in by server hint — a server that sends `ttlMs: 0` (the SDK's default stamp) sees no behaviour change. Per-call override: pass `{ cacheMode: 'refresh' }` (always fetch and re-store) or `{ cacheMode: 'bypass' }` (fetch without touching the cache). Server `ttlMs` is clamped at 24 h (`MAX_CACHE_TTL_MS`). Entries are automatically scoped by connected-server identity; new `ClientOptions.cachePartition` (per-principal slot for `'private'`-scoped entries on a shared `responseCacheStore`; default `''`) and `ClientOptions.defaultCacheTtlMs` (TTL when the result lacks one, e.g. legacy-era responses; default `0`). `ResponseCacheStore` gained `delete(key)` (driven by `notifications/resources/updated`); `InMemoryResponseCacheStore` is now bounded (`{ maxEntries }`, default 512).

Output-schema validator compilation is now lazy (first `callTool()` against the cached `tools/list` entry); `listTools()` no longer throws on an uncompilable `outputSchema` — every tool stays listed and the compile failure is captured per-tool. Calling `callTool()` on the affected tool throws `ProtocolError(InvalidParams, "Tool 'X' has an invalid outputSchema: …")` before the request is sent (validation is never silently skipped). Applies on every era — the legacy-era `listTools()` path is unchanged at the wire level only.

New (no v1 equivalent): `Client.connect(transport, { prior: DiscoverResult })` — zero-round-trip connect (2026-07-28+ only; throws `EraNegotiationFailed` otherwise). Probe once, persist `client.getDiscoverResult()` (`JSON.stringify`), feed to every worker. New exported type:
`ConnectOptions` (extends `RequestOptions` with `prior?: DiscoverResult`).

OAuth callback handling: pass the callback URL's `URLSearchParams` to `transport.finishAuth(url.searchParams)` (or pass `iss` alongside `authorizationCode` to `auth()` / `finishAuth(code, iss)`). The SDK now validates `iss` per RFC 9207: a mismatched `iss` throws `IssuerMismatchError` regardless of advertised support; a missing `iss` throws only when the AS advertised `authorization_response_iss_parameter_supported: true`. Do not surface `error_description` / `error_uri` from a callback that failed this check.

`discoverAuthorizationServerMetadata()` now rejects metadata whose `issuer` does not exactly match the URL it was fetched for (RFC 8414 §3.3), throwing `IssuerMismatchError`. Pass `skipIssuerMetadataValidation: true` on `AuthOptions` (or `skipIssuerValidation: true` on the helper) only as a temporary workaround for a known-misconfigured AS.

`auth()` reads `provider.clientMetadata` once via `resolveClientMetadata()` and applies SEP-837/SEP-2207 defaults to the DCR body: `grant_types` defaults to `['authorization_code', 'refresh_token']`; `application_type` is derived from `redirect_uris` (loopback / custom URI scheme → `'native'`, otherwise `'web'`). A field you set explicitly is never overwritten — set `clientMetadata.application_type` / `clientMetadata.grant_types` to override. Direct `registerClient()` callers wanting the same defaults pass `resolveClientMetadata(provider)` as `clientMetadata`. The `grant_types` default applies to the Dynamic Client Registration body only; it does **not** drive the `offline_access` scope / `prompt=consent` augmentation on the authorize request — statically-registered and CIMD clients that want that augmentation must set `clientMetadata.grant_types` explicitly. Non-interactive providers (no `redirectUrl`) get no `grant_types` default.

Token-exchange / refresh now refuse to send credentials to a non-`https:` token endpoint (loopback `localhost` / `127.0.0.1` / `::1` exempt), throwing `InsecureTokenEndpointError` with no opt-out. `auth()` surfaces this on every path including refresh — switch any plain-`http:` AS on a non-loopback host to TLS.

No code changes required; wire-behavior note: on a 2026-07-28 Streamable HTTP connection, aborting an in-flight client request (caller `signal` / timeout) closes that request's SSE response stream as the spec cancellation signal — `notifications/cancelled` is no longer POSTed
there. 2025-era connections and stdio at any era still send `notifications/cancelled`. Custom `Transport` implementations that open one underlying request per outbound message and honor `TransportSendOptions.requestSignal` may declare `readonly hasPerRequestStream = true` to opt
into the same routing.

### Server (Streamable HTTP transport)

No code changes required; these are wire-behavior notes:

- `resources/read` for an unknown URI answers JSON-RPC error code `-32602` (Invalid Params) on every protocol revision, with `error.data.uri` echoing the requested URI. Earlier v2 alphas emitted `-32002`; v1.x already emitted `-32602`, so v1.x peers see no change. Throw the typed
  `ResourceNotFoundError` from a custom resource handler; a handler-thrown `-32002` is still mapped to `-32602` on the wire by the encode seam. Clients accept both codes; `ProtocolErrorCode.ResourceNotFound` (`-32002`) stays importable as receive-tolerated vocabulary.
- Resumability behavior (SSE priming events, `closeSSEStream` / `closeStandaloneSSEStream` callbacks) is only enabled for protocol versions in the transport's supported-versions list that are `>= 2025-11-25`. Unknown future version strings in an `initialize` request body no
  longer enable it. Behavior for all currently supported protocol versions is unchanged.
- Session-ID mismatch still responds `404 Not Found` with JSON-RPC error code `-32001` (`Session not found`), unchanged from v1. This `-32001` usage is an SDK convention, not a spec-assigned code, and may be re-derived as 2026 protocol revision error handling is adopted —
  migrated client code should key off the HTTP `404` status, not the `-32001` code.
- The 2026-07-28 draft error codes were renumbered between v2 alphas: `HeaderMismatch` `-32001`→`-32020`, `MissingRequiredClientCapability` `-32003`→`-32021`, `UnsupportedProtocolVersion` `-32004`→`-32022`. No v1.x→v2 impact (these codes never existed in v1); v2-alpha code that
  hard-coded the old literals must update — prefer `ProtocolErrorCode.*` / `HEADER_MISMATCH_ERROR_CODE`.

### Server (deprecated accessors and app-factory Origin validation)

These can require code changes:

- `Server.getClientCapabilities()`, `getClientVersion()` and `getNegotiatedProtocolVersion()` are deprecated but functional: prefer the per-request context (`ctx.mcpReq.envelope`) on 2026-07-28 requests. No mechanical change required yet; plan the move before the deprecations are
  removed.
- `createMcpExpressApp()` / `createMcpHonoApp()` / `createMcpFastifyApp()` with a localhost-class `host` now also validate the `Origin` header by default (requests without an `Origin` header are unaffected). Browser-served clients on a non-localhost origin need
  `allowedOrigins: [...]`, which replaces the default localhost allowlist — Origin validation cannot be disabled for localhost-class binds.

### Server (HTTP entry: createMcpHandler — serving the 2026-07-28 draft revision)

New in 2.0 — v1 has no equivalent API. How v1 Streamable HTTP hosting maps onto the entry:

- `createMcpHandler(factory)` from `@modelcontextprotocol/server` serves the 2026-07-28 draft revision per request and, out of the box, also serves 2025-era (non-envelope) traffic through per-request stateless serving (`legacy: 'stateless'`, the default) — one factory, one
  endpoint, both eras. A v1 stateless `StreamableHTTPServerTransport` hosting (`sessionIdGenerator: undefined`, fresh transport per request) maps directly onto the default entry.
- Pass `legacy: 'reject'` for a strict, modern-only endpoint: 2025-era requests are rejected with the unsupported-protocol-version error naming the supported revisions, and 2025-era notifications are acknowledged with `202` and dropped. The option type is
  `legacy?: 'stateless' | 'reject'`.
- An existing sessionful v1 Streamable HTTP setup (a `StreamableHTTPServerTransport` wiring with session IDs) keeps serving 2025 clients by routing in user land in front of a strict entry:
  `if (await isLegacyRequest(request)) return myExistingLegacyHandler(request); return strictHandler.fetch(request)` where `strictHandler = createMcpHandler(factory, { legacy: 'reject' })`.
- `isLegacyRequest(request: Request, parsedBody?: unknown): Promise<boolean>` from `@modelcontextprotocol/server` is the entry's own classification step. Returns `true` only for requests with no per-request `_meta` envelope claim (claim-less POSTs including `initialize`,
  GET/DELETE session operations, all-legacy batches, posted responses, non-JSON bodies). Returns `false` for envelope-claiming requests AND for malformed/incomplete modern claims (the modern path answers those with `-32602`/`-32020`) — route `false` traffic to the modern handler,
  never to a legacy handler. The predicate classifies a clone (the body stays readable); pass the parsed body as the second argument when the stream was already consumed.
- `legacyStatelessFallback(factory)` is exported as a standalone fetch-shaped handler producing the same stateless legacy serving as the default.
- The handler is web-standards-only (`{ fetch, close, notify, bus }`). On Workers / Bun / Deno, `export default handler` works directly. On Node frameworks (Express, Fastify, plain `node:http`), wrap once with `toNodeHandler(handler, { onerror? })` from
  `@modelcontextprotocol/node`: `app.all('/mcp', toNodeHandler(handler))`, or `const node = toNodeHandler(handler); app.all('/mcp', (req, res) => void node(req, res, req.body))` when a body parser already consumed the stream. The optional `onerror` receives the adapter-level
  error fallback (request conversion / `handler.fetch` throw) before the `500` response is written. Earlier 2.x alphas exposed this as `handler.node(req, res, req.body)` — replace with the `toNodeHandler` wrap and add the `@modelcontextprotocol/node` import.
  `NodeIncomingMessageLike` / `NodeServerResponseLike` are now exported from `@modelcontextprotocol/node`, not `@modelcontextprotocol/server`.

### Server (stdio / long-lived connections)

- A hand-constructed `Server`/`McpServer` connected to a `StdioServerTransport` serves only the 2025-era protocol it was written for: today's behavior, byte-identical — no change required during a mechanical migration.
- Serving the 2026-07-28 draft revision (or both eras) on stdio goes through the connection-pinned entry: `serveStdio(() => new McpServer(info, options))` from `@modelcontextprotocol/server/stdio`. The opening exchange selects the connection's era (2025 `initialize` vs 2026
  per-request envelope, with `server/discover` answered as a probe); one factory instance is pinned per connection. There is no per-instance option that makes a hand-constructed server serve the 2026 revision: move the v1 `server.connect(new StdioServerTransport())` call into
  `serveStdio(() => buildServer())`. `serveStdio(factory, { legacy: 'reject' })` refuses 2025-era openings with the unsupported-protocol-version error.
- On 2026-pinned stdio connections `getClientCapabilities()` / `getClientVersion()` return `undefined` (no `initialize` ever runs there) and handlers read per-request identity from `ctx.mcpReq.envelope`; `getNegotiatedProtocolVersion()` reports the pinned revision (`2026-07-28`),
  as on instances served through `createMcpHandler`. 2025-pinned connections keep the `initialize`-scoped semantics for all three accessors.
- A client whose connection negotiated a modern era drops inbound server→client JSON-RPC requests (the 2026 era has no such channel) instead of answering them; legacy-era connections are unchanged.

## 14. Runtime-Specific JSON Schema Validators (Enhancement)

The SDK now auto-selects the appropriate JSON Schema validator based on runtime:

- Node.js → AJV (no change from v1)
- Cloudflare Workers (workerd) → `@cfworker/json-schema` (previously required manual config)

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

Validator behavior:

- Do not add validator imports for normal migrations.
- Do not install `ajv`, `ajv-formats`, or `@cfworker/json-schema` for the default path; client/server bundle the runtime-selected defaults and the root entry point does not pull either dep in.
- To customize the built-in backend (e.g. register custom AJV formats, change `@cfworker/json-schema` draft), import the named class from the package subpath: `@modelcontextprotocol/{client,server}/validators/ajv` for `AjvJsonSchemaValidator`,
  `@modelcontextprotocol/{client,server}/validators/cf-worker` for `CfWorkerJsonSchemaValidator`. Importing from a subpath means the corresponding peer dep must be in your `package.json`.
- To replace validation entirely, pass `jsonSchemaValidator: myCustomValidator` with your own implementation of the `jsonSchemaValidator` interface.

JSON Schema 2020-12 posture (SEP-1613 / SEP-2106): the default validator supports JSON Schema 2020-12 only (the spec's only MUST) — on Node it is now `Ajv2020` instead of draft-07 `Ajv`. Schemas declaring a different `$schema` are rejected with a clear `Error("…unsupported
dialect…")`; to validate other dialects, pass a pre-configured Ajv instance: `new AjvJsonSchemaValidator(new Ajv({...}))`. `CallToolResult.structuredContent` is typed `unknown` (was `{ [k: string]: unknown }`). The presence check is `!== undefined`, not falsy. External `$ref`
is not dereferenced (unchanged from v1; Ajv throws `MissingRefError` at compile, surfaced per-tool on `callTool`). Toward 2025-era clients a non-object `outputSchema`/`structuredContent` is wrapped in a `{result:…}` envelope.

| v1 pattern                                                         | Mechanical fix                                                                                                                                                                                                 |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `result.structuredContent.<key>` / `result.structuredContent?.<k>` | narrow first: `const sc = result.structuredContent; if (typeof sc === 'object' && sc !== null && '<k>' in sc) { sc.<k> }`                                                                                      |
| `if (!result.structuredContent)`                                   | `if (result.structuredContent === undefined)`                                                                                                                                                                  |
| relying on default `Ajv` being draft-07                            | `const ajv = new Ajv({ strict: false, validateFormats: true, validateSchema: false, allErrors: true }); addFormats(ajv); new AjvJsonSchemaValidator(ajv)` (import `Ajv`, `addFormats` from `…/validators/ajv`) |
| draft-07 idioms via `fromJsonSchema(schema)`                       | `fromJsonSchema(schema, new AjvJsonSchemaValidator(ajv))` — the `McpServer`/`Client` `jsonSchemaValidator` option does **not** reach `fromJsonSchema`-authored schemas                                         |
| `outputSchema` or `inputSchema` with absolute-URI `$ref`           | inline under `$defs` and reference with `#/$defs/Name`                                                                                                                                                         |

## 15. Migration Steps (apply in this order)

1. Update `package.json`: `npm uninstall @modelcontextprotocol/sdk`, install the appropriate v2 packages
2. Replace all imports from `@modelcontextprotocol/sdk/...` using the import mapping tables (sections 3-4), including `StreamableHTTPServerTransport` → `NodeStreamableHTTPServerTransport`
3. Replace removed type aliases (`JSONRPCError` → `JSONRPCErrorResponse`, etc.) per section 5
4. Replace `.tool()` / `.prompt()` / `.resource()` calls with `registerTool` / `registerPrompt` / `registerResource` per section 6
5. **Wrap all raw Zod shapes with `z.object()`**: Change `inputSchema: { name: z.string() }` → `inputSchema: z.object({ name: z.string() })`. Same for `outputSchema` in tools and `argsSchema` in prompts.
6. Replace plain header objects with `new Headers({...})` and bracket access (`headers['x']`) with `.get()` calls per section 7
7. If using `hostHeaderValidation` from server, update import and signature per section 8
8. If using server SSE transport, migrate to Streamable HTTP
9. If using server auth from the SDK: RS helpers (`requireBearerAuth`, `mcpAuthMetadataRouter`, `OAuthTokenVerifier`) → `@modelcontextprotocol/express`; AS helpers → `@modelcontextprotocol/server-legacy/auth` (deprecated); migrate AS to external IdP/OAuth library
10. If relying on `listTools()`/`listPrompts()`/etc. throwing on missing capabilities, set `enforceStrictCapabilities: true`
11. Verify: build with `tsc` / run tests
