# Migration Guide: v1 to v2

This guide covers the breaking changes introduced in v2 of the MCP TypeScript SDK and how to update your code.

## Overview

Version 2 of the MCP TypeScript SDK introduces several breaking changes to improve modularity, reduce dependency bloat, and provide a cleaner API surface. The biggest change is the split from a single `@modelcontextprotocol/sdk` package into separate `@modelcontextprotocol/core`,
`@modelcontextprotocol/client`, and `@modelcontextprotocol/server` packages.

## Breaking Changes

### Package split (monorepo)

The single `@modelcontextprotocol/sdk` package has been split into three packages:

| v1                          | v2                                                         |
| --------------------------- | ---------------------------------------------------------- |
| `@modelcontextprotocol/sdk` | `@modelcontextprotocol/core` (types, protocol, transports) |
|                             | `@modelcontextprotocol/client` (client implementation)     |
|                             | `@modelcontextprotocol/server` (server implementation)     |

Remove the old package and install only the packages you need:

```bash
npm uninstall @modelcontextprotocol/sdk

# If you only need a client
npm install @modelcontextprotocol/client

# If you only need a server
npm install @modelcontextprotocol/server

# Both packages depend on @modelcontextprotocol/core automatically
```

Update your imports accordingly:

**Before (v1):**

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
```

**After (v2):**

```typescript
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

// Node.js HTTP server transport is in the @modelcontextprotocol/node package
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
```

Note: `@modelcontextprotocol/client` and `@modelcontextprotocol/server` both re-export shared types from `@modelcontextprotocol/core`, so you can import types and error classes from whichever package you already depend on. Do not import from `@modelcontextprotocol/core` directly
— it is an internal package.

### Dropped Node.js 18 and CommonJS

v2 requires **Node.js 20+** and ships **ESM only** (no more CommonJS builds).

If your project uses CommonJS (`require()`), you will need to either:

- Migrate to ESM (`import`/`export`)
- Use dynamic `import()` to load the SDK

### Server decoupled from HTTP frameworks

The server package no longer depends on Express or Hono. HTTP framework integrations are now separate middleware packages:

| v1                                     | v2                                          |
| -------------------------------------- | ------------------------------------------- |
| Built into `@modelcontextprotocol/sdk` | `@modelcontextprotocol/node` (Node.js HTTP) |
|                                        | `@modelcontextprotocol/express` (Express)   |
|                                        | `@modelcontextprotocol/hono` (Hono)         |

Install the middleware package for your framework:

```bash
npm install @modelcontextprotocol/node       # Node.js native http
npm install @modelcontextprotocol/express    # Express
npm install @modelcontextprotocol/hono       # Hono
```

### `StreamableHTTPServerTransport` renamed

`StreamableHTTPServerTransport` has been renamed to `NodeStreamableHTTPServerTransport` and moved to `@modelcontextprotocol/node`.

**Before (v1):**

```typescript
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
```

**After (v2):**

```typescript
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';

const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
```

### Server-side SSE transport removed

The SSE transport has been removed from the server. Servers should migrate to Streamable HTTP. The client-side SSE transport remains available for connecting to legacy SSE servers.

### `WebSocketClientTransport` removed

`WebSocketClientTransport` has been removed. WebSocket is not a spec-defined MCP transport, and keeping it in the SDK encouraged transport proliferation without a conformance baseline.

Use `StdioClientTransport` for local servers or `StreamableHTTPClientTransport` for remote servers. If you need WebSocket for a custom deployment, implement the `Transport` interface directly — it remains exported from `@modelcontextprotocol/client`.

**Before (v1):**

```typescript
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
const transport = new WebSocketClientTransport(new URL('ws://localhost:3000'));
```

**After (v2):**

```typescript
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'));
```

### Server auth split

Resource Server helpers (`requireBearerAuth`, `mcpAuthMetadataRouter`, `getOAuthProtectedResourceMetadataUrl`, `OAuthTokenVerifier`) are now first-class in `@modelcontextprotocol/express`.

Authorization Server helpers (`mcpAuthRouter`, `OAuthServerProvider`, `ProxyOAuthServerProvider`, `authenticateClient`, `allowedMethods`, etc.) have been removed from the core SDK; new code should use a dedicated IdP/OAuth library. See the [examples](../examples/server/src/) for a working demo with `better-auth`.

Note: `AuthInfo` has moved from `server/auth/types.ts` to the core types and is now re-exported by `@modelcontextprotocol/client` and `@modelcontextprotocol/server`.

### `Headers` object instead of plain objects

Transport APIs and `RequestInfo.headers` now use the Web Standard `Headers` object instead of plain `Record<string, string | string[] | undefined>` (`IsomorphicHeaders` has been removed).

This affects both transport constructors and request handler code that reads headers:

**Before (v1):**

```typescript
// Transport headers
const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
        headers: {
            Authorization: 'Bearer token',
            'X-Custom': 'value'
        }
    }
});

// Reading headers in a request handler
const sessionId = extra.requestInfo?.headers['mcp-session-id'];
```

**After (v2):**

```typescript
// Transport headers
const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
        headers: new Headers({
            Authorization: 'Bearer token',
            'X-Custom': 'value'
        })
    }
});

// Reading headers in a request handler (ctx.http.req is the standard Web Request object)
const sessionId = ctx.http?.req?.headers.get('mcp-session-id');

// Reading query parameters
const url = new URL(ctx.http!.req!.url);
const debug = url.searchParams.get('debug');
```

### `McpServer.tool()`, `.prompt()`, `.resource()` removed

The deprecated variadic-overload methods have been removed. Use `registerTool`, `registerPrompt`, and `registerResource` instead. These use an explicit config object rather than positional arguments.

**Before (v1):**

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const server = new McpServer({ name: 'demo', version: '1.0.0' });

// Tool with schema
server.tool('greet', { name: z.string() }, async ({ name }) => {
    return { content: [{ type: 'text', text: `Hello, ${name}!` }] };
});

// Tool with description
server.tool('greet', 'Greet a user', { name: z.string() }, async ({ name }) => {
    return { content: [{ type: 'text', text: `Hello, ${name}!` }] };
});

// Prompt
server.prompt('summarize', { text: z.string() }, async ({ text }) => {
    return { messages: [{ role: 'user', content: { type: 'text', text: `Summarize: ${text}` } }] };
});

// Resource
server.resource('config', 'config://app', async uri => {
    return { contents: [{ uri: uri.href, text: '{}' }] };
});
```

**After (v2):**

```typescript
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const server = new McpServer({ name: 'demo', version: '1.0.0' });

// Tool with schema
server.registerTool('greet', { inputSchema: z.object({ name: z.string() }) }, async ({ name }) => {
    return { content: [{ type: 'text', text: `Hello, ${name}!` }] };
});

// Tool with description
server.registerTool('greet', { description: 'Greet a user', inputSchema: z.object({ name: z.string() }) }, async ({ name }) => {
    return { content: [{ type: 'text', text: `Hello, ${name}!` }] };
});

// Prompt
server.registerPrompt('summarize', { argsSchema: z.object({ text: z.string() }) }, async ({ text }) => {
    return { messages: [{ role: 'user', content: { type: 'text', text: `Summarize: ${text}` } }] };
});

// Resource
server.registerResource('config', 'config://app', {}, async uri => {
    return { contents: [{ uri: uri.href, text: '{}' }] };
});
```

### Standard Schema objects required (raw shapes no longer supported)

v2 requires schema objects implementing the [Standard Schema spec](https://standardschema.dev/) for `inputSchema`, `outputSchema`, and `argsSchema`. Raw object shapes are no longer accepted. Zod v4, ArkType, and Valibot all implement the spec.

**Before (v1):**

```typescript
// Raw shape (object with Zod fields) - worked in v1
server.tool('greet', { name: z.string() }, async ({ name }) => { ... });

server.registerTool('greet', {
  inputSchema: { name: z.string() }  // raw shape
}, callback);
```

**After (v2):**

```typescript
import * as z from 'zod/v4';

// Wrap with z.object() (or use any Standard Schema library)
server.registerTool('greet', {
  inputSchema: z.object({ name: z.string() })
}, async ({ name }) => { ... });

// ArkType works too
import { type } from 'arktype';
server.registerTool('greet', {
  inputSchema: type({ name: 'string' })
}, async ({ name }) => { ... });

// Raw JSON Schema via fromJsonSchema (validator defaults to runtime-appropriate choice)
import { fromJsonSchema } from '@modelcontextprotocol/server';
server.registerTool('greet', {
  inputSchema: fromJsonSchema({ type: 'object', properties: { name: { type: 'string' } } })
}, handler);

// For tools with no parameters, use z.object({})
server.registerTool('ping', {
  inputSchema: z.object({})
}, async () => { ... });
```

This applies to:

- `inputSchema` in `registerTool()`
- `outputSchema` in `registerTool()`
- `argsSchema` in `registerPrompt()`

**Removed Zod-specific helpers** from `@modelcontextprotocol/core` (use Standard Schema equivalents):

| Removed                                                                              | Replacement                                                       |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `schemaToJson(schema)`                                                               | `standardSchemaToJsonSchema(schema)`                              |
| `parseSchemaAsync(schema, data)`                                                     | `validateStandardSchema(schema, data)`                            |
| `SchemaInput<T>`                                                                     | `StandardSchemaWithJSON.InferInput<T>`                            |
| `getSchemaShape`, `getSchemaDescription`, `isOptionalSchema`, `unwrapOptionalSchema` | No replacement — these are now internal Zod introspection helpers |

### Host header validation moved

Express-specific middleware (`hostHeaderValidation()`, `localhostHostValidation()`) moved from the server package to `@modelcontextprotocol/express`. The server package now exports framework-agnostic functions instead: `validateHostHeader()`, `localhostAllowedHostnames()`,
`hostHeaderValidationResponse()`.

**Before (v1):**

```typescript
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware.js';
app.use(hostHeaderValidation({ allowedHosts: ['example.com'] }));
```

**After (v2):**

```typescript
import { hostHeaderValidation } from '@modelcontextprotocol/express';
app.use(hostHeaderValidation(['example.com']));
```

Note: the v2 signature takes a plain `string[]` instead of an options object.

### `setRequestHandler` and `setNotificationHandler` use method strings

The low-level `setRequestHandler` and `setNotificationHandler` methods on `Client`, `Server`, and `Protocol` now take a method string instead of a Zod schema.

**Before (v1):**

```typescript
import { Server, InitializeRequestSchema, LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/server/index.js';

const server = new Server({ name: 'my-server', version: '1.0.0' });

// Request handler with schema
server.setRequestHandler(InitializeRequestSchema, async request => {
    return { protocolVersion: '...', capabilities: {}, serverInfo: { name: '...', version: '...' } };
});

// Notification handler with schema
server.setNotificationHandler(LoggingMessageNotificationSchema, notification => {
    console.log(notification.params.data);
});
```

**After (v2):**

```typescript
import { Server } from '@modelcontextprotocol/server';

const server = new Server({ name: 'my-server', version: '1.0.0' });

// Request handler with method string
server.setRequestHandler('initialize', async request => {
    return { protocolVersion: '...', capabilities: {}, serverInfo: { name: '...', version: '...' } };
});

// Notification handler with method string
server.setNotificationHandler('notifications/message', notification => {
    console.log(notification.params.data);
});
```

The request and notification parameters remain fully typed via `RequestTypeMap` and `NotificationTypeMap`. You no longer need to import the individual `*RequestSchema` or `*NotificationSchema` constants for handler registration.

#### Custom (non-spec) methods

For vendor-prefixed methods (anything not in the MCP spec), use the 3-arg form: pass the method string, a `{ params, result? }` schemas object, and the handler. Any [Standard Schema](https://standardschema.dev) library works (Zod, Valibot, ArkType).

**Before (v1):**

```typescript
const AcmeSearch = z.object({
    method: z.literal('acme/search'),
    params: z.object({ query: z.string(), limit: z.number().int() })
});
server.setRequestHandler(AcmeSearch, async request => {
    return { items: [/* ... */] };
});
```

**After (v2):**

```typescript
const SearchParams = z.object({ query: z.string(), limit: z.number().int() });
const SearchResult = z.object({ items: z.array(z.string()) });

server.setRequestHandler('acme/search', { params: SearchParams, result: SearchResult }, async (params, ctx) => {
    return { items: [/* ... */] };
});
```

The handler receives the parsed `params` directly (not the full request envelope). `_meta` is stripped before validation and is available as `ctx.mcpReq._meta`. Supplying `result` types the handler's return value; omit it to return any `Result`.

For `setNotificationHandler`, the 3-arg handler is `(params, notification) => void`. The raw notification is the second argument, so `_meta` is recoverable via `notification.params?._meta`.

#### Sending custom-method requests

`request()` and `ctx.mcpReq.send()` accept a result schema as the second argument; for custom methods this is required:

```typescript
const result = await client.request({ method: 'acme/search', params: { query: 'mcp', limit: 3 } }, SearchResult);
result.items; // string[]
```

For spec methods the 1-arg form still works and the result type is inferred from the method name.

Common method string replacements:

| Schema (v1)                             | Method string (v2)                       |
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
| `LoggingMessageNotificationSchema`      | `'notifications/message'`                |
| `ToolListChangedNotificationSchema`     | `'notifications/tools/list_changed'`     |
| `ResourceListChangedNotificationSchema` | `'notifications/resources/list_changed'` |
| `PromptListChangedNotificationSchema`   | `'notifications/prompts/list_changed'`   |

### `Protocol.request()`, `ctx.mcpReq.send()`, and `Client.callTool()` no longer require a schema parameter for spec methods

For **spec** methods, the public `Protocol.request()`, `BaseContext.mcpReq.send()`, and `Client.callTool()` methods no longer require a Zod result schema argument. The SDK now resolves the correct result schema internally based on the method name. This means you no longer need to import result schemas
like `CallToolResultSchema` or `ElicitResultSchema` when making spec-method requests.

**`client.request()` — Before (v1):**

```typescript
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

const result = await client.request({ method: 'tools/call', params: { name: 'my-tool', arguments: {} } }, CallToolResultSchema);
```

**After (v2):**

```typescript
const result = await client.request({ method: 'tools/call', params: { name: 'my-tool', arguments: {} } });
```

**`ctx.mcpReq.send()` — Before (v1):**

```typescript
import { CreateMessageResultSchema } from '@modelcontextprotocol/sdk/types.js';

server.setRequestHandler('tools/call', async (request, ctx) => {
    const samplingResult = await ctx.mcpReq.send(
        { method: 'sampling/createMessage', params: { messages: [...], maxTokens: 100 } },
        CreateMessageResultSchema
    );
    return { content: [{ type: 'text', text: 'done' }] };
});
```

**After (v2):**

```typescript
server.setRequestHandler('tools/call', async (request, ctx) => {
    const samplingResult = await ctx.mcpReq.send(
        { method: 'sampling/createMessage', params: { messages: [...], maxTokens: 100 } }
    );
    return { content: [{ type: 'text', text: 'done' }] };
});
```

**`client.callTool()` — Before (v1):**

```typescript
import { CompatibilityCallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

const result = await client.callTool({ name: 'my-tool', arguments: {} }, CompatibilityCallToolResultSchema);
```

**After (v2):**

```typescript
const result = await client.callTool({ name: 'my-tool', arguments: {} });
```

The return type is now inferred from the method name via `ResultTypeMap`. For example, `client.request({ method: 'tools/call', ... })` returns `Promise<CallToolResult | CreateTaskResult>`.

For **custom (non-spec)** methods, keep the result-schema argument — see [Sending custom-method requests](#sending-custom-method-requests). Only drop the schema when calling a spec method.

If you were using `CallToolResultSchema` (or any `*Schema` constant) for **runtime validation** (not just in `request()`/`callTool()` calls), use `isSpecType` or `specTypeSchemas`:

```typescript
// v1: runtime validation with Zod schema
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
if (CallToolResultSchema.safeParse(value).success) {
    /* ... */
}

// v2: keyed type predicate
import { isSpecType } from '@modelcontextprotocol/client';
if (isSpecType.CallToolResult(value)) {
    /* ... */
}
const blocks = mixed.filter(isSpecType.ContentBlock);

// v2: or get the StandardSchemaV1 validator object directly
import { specTypeSchemas } from '@modelcontextprotocol/client';
const result = await specTypeSchemas.CallToolResult['~standard'].validate(value);
```

`isSpecType` and `specTypeSchemas` are keyed by `SpecTypeName` — a literal union of every named type in the MCP spec — so you get autocomplete and a compile error on typos. `specTypeSchemas.X` is a `StandardSchemaV1<In, Out>`, which composes with any Standard-Schema-aware library. The pre-existing `isCallToolResult(value)` guard still works.

### Client list methods return empty results for missing capabilities

`Client.listPrompts()`, `listResources()`, `listResourceTemplates()`, and `listTools()` now return empty results when the server didn't advertise the corresponding capability, instead of sending the request. This respects the MCP spec's capability negotiation.

To restore v1 behavior (throw an error when capabilities are missing), set `enforceStrictCapabilities: true`:

```typescript
const client = new Client(
    { name: 'my-client', version: '1.0.0' },
    {
        enforceStrictCapabilities: true
    }
);
```

### `InMemoryTransport` moved

`InMemoryTransport` is now exported from `@modelcontextprotocol/client` and `@modelcontextprotocol/server` (both re-export it). It is still intended for in-process client-server connections and testing.

```typescript
// v1
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// v2
import { InMemoryTransport } from '@modelcontextprotocol/server';
// or
import { InMemoryTransport } from '@modelcontextprotocol/client';
```

### Removed type aliases and deprecated exports

The following deprecated type aliases have been removed from `@modelcontextprotocol/core`:

| Removed                                  | Replacement                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `JSONRPCError`                           | `JSONRPCErrorResponse`                                                                            |
| `JSONRPCErrorSchema`                     | `JSONRPCErrorResponseSchema`                                                                      |
| `isJSONRPCError`                         | `isJSONRPCErrorResponse`                                                                          |
| `isJSONRPCResponse`                      | `isJSONRPCResultResponse` (see note below)                                                        |
| `ResourceReferenceSchema`                | `ResourceTemplateReferenceSchema`                                                                 |
| `ResourceReference`                      | `ResourceTemplateReference`                                                                       |
| `IsomorphicHeaders`                      | Use Web Standard `Headers`                                                                        |
| `AuthInfo` (from `server/auth/types.js`) | `AuthInfo` (now re-exported by `@modelcontextprotocol/client` and `@modelcontextprotocol/server`) |

All other types and schemas exported from `@modelcontextprotocol/sdk/types.js` retain their original names — import them from `@modelcontextprotocol/client` or `@modelcontextprotocol/server`.

> **Note on `isJSONRPCResponse`:** v1's `isJSONRPCResponse` was a deprecated alias that only checked for _result_ responses (it was equivalent to `isJSONRPCResultResponse`). v2 removes the deprecated alias and introduces a **new** `isJSONRPCResponse` with corrected semantics — it
> checks for _any_ response (either result or error). If you are migrating v1 code that used `isJSONRPCResponse`, rename it to `isJSONRPCResultResponse` to preserve the original behavior. Use the new `isJSONRPCResponse` only when you want to match both result and error responses.

**Before (v1):**

```typescript
import { JSONRPCError, ResourceReference, isJSONRPCError } from '@modelcontextprotocol/sdk/types.js';
```

**After (v2):**

```typescript
import { JSONRPCErrorResponse, ResourceTemplateReference, isJSONRPCErrorResponse } from '@modelcontextprotocol/server';
```

### Request handler context types

The `RequestHandlerExtra` type has been replaced with a structured context type hierarchy using nested groups:

| v1                                       | v2                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| `RequestHandlerExtra` (flat, all fields) | `ServerContext` (server handlers) or `ClientContext` (client handlers) |
| `extra` parameter name                   | `ctx` parameter name                                                   |
| `extra.signal`                           | `ctx.mcpReq.signal`                                                    |
| `extra.requestId`                        | `ctx.mcpReq.id`                                                        |
| `extra._meta`                            | `ctx.mcpReq._meta`                                                     |
| `extra.sendRequest(...)`                 | `ctx.mcpReq.send(...)`                                                 |
| `extra.sendNotification(...)`            | `ctx.mcpReq.notify(...)`                                               |
| `extra.authInfo`                         | `ctx.http?.authInfo`                                                   |
| `extra.requestInfo`                      | `ctx.http?.req` (standard Web `Request`, only on `ServerContext`)      |
| `extra.closeSSEStream`                   | `ctx.http?.closeSSE` (only on `ServerContext`)                         |
| `extra.closeStandaloneSSEStream`         | `ctx.http?.closeStandaloneSSE` (only on `ServerContext`)               |
| `extra.sessionId`                        | `ctx.sessionId`                                                        |
| `extra.taskStore`                        | `ctx.task?.store`                                                      |
| `extra.taskId`                           | `ctx.task?.id`                                                         |
| `extra.taskRequestedTtl`                 | `ctx.task?.requestedTtl`                                               |

**Before (v1):**

```typescript
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const headers = extra.requestInfo?.headers;
    const taskStore = extra.taskStore;
    await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: 'abc', progress: 50, total: 100 } });
    return { content: [{ type: 'text', text: 'result' }] };
});
```

**After (v2):**

```typescript
server.setRequestHandler('tools/call', async (request, ctx) => {
    const headers = ctx.http?.req?.headers; // standard Web Request object
    const taskStore = ctx.task?.store;
    await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: 'abc', progress: 50, total: 100 } });
    return { content: [{ type: 'text', text: 'result' }] };
});
```

Context fields are organized into 4 groups:

- **`mcpReq`** — request-level concerns: `id`, `method`, `_meta`, `signal`, `send()`, `notify()`, plus server-only `log()`, `elicitInput()`, and `requestSampling()`
- **`http?`** — HTTP transport concerns (undefined for stdio): `authInfo`, plus server-only `req`, `closeSSE`, `closeStandaloneSSE`
- **`task?`** — task lifecycle: `id`, `store`, `requestedTtl`

`BaseContext` is the common base type shared by both `ServerContext` and `ClientContext`. `ServerContext` extends each group with server-specific additions via type intersection.

`ServerContext` also provides convenience methods for common server→client operations:

```typescript
server.setRequestHandler('tools/call', async (request, ctx) => {
    // Send a log message (respects client's log level filter)
    await ctx.mcpReq.log('info', 'Processing tool call', 'my-logger');

    // Request client to sample an LLM
    const samplingResult = await ctx.mcpReq.requestSampling({
        messages: [{ role: 'user', content: { type: 'text', text: 'Hello' } }],
        maxTokens: 100
    });

    // Elicit user input via a form
    const elicitResult = await ctx.mcpReq.elicitInput({
        message: 'Please provide details',
        requestedSchema: { type: 'object', properties: { name: { type: 'string' } } }
    });

    return { content: [{ type: 'text', text: 'done' }] };
});
```

These replace the pattern of calling `server.sendLoggingMessage()`, `server.createMessage()`, and `server.elicitInput()` from within handlers.

### Error hierarchy refactoring

The SDK now distinguishes between two types of errors:

1. **`ProtocolError`** (renamed from `McpError`): Protocol errors that cross the wire as JSON-RPC error responses
2. **`SdkError`**: Local SDK errors that never cross the wire (timeouts, connection issues, capability checks)

#### Renamed exports

| v1                           | v2                              |
| ---------------------------- | ------------------------------- |
| `McpError`                   | `ProtocolError`                 |
| `ErrorCode`                  | `ProtocolErrorCode`             |
| `ErrorCode.RequestTimeout`   | `SdkErrorCode.RequestTimeout`   |
| `ErrorCode.ConnectionClosed` | `SdkErrorCode.ConnectionClosed` |

**Before (v1):**

```typescript
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

try {
    await client.callTool({ name: 'test', arguments: {} });
} catch (error) {
    if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
        console.log('Request timed out');
    }
    if (error instanceof McpError && error.code === ErrorCode.InvalidParams) {
        console.log('Invalid parameters');
    }
}
```

**After (v2):**

```typescript
import { ProtocolError, ProtocolErrorCode, SdkError, SdkErrorCode } from '@modelcontextprotocol/client';

try {
    await client.callTool({ name: 'test', arguments: {} });
} catch (error) {
    // Local timeout/connection errors are now SdkError
    if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) {
        console.log('Request timed out');
    }
    // Protocol errors from the server are still ProtocolError
    if (error instanceof ProtocolError && error.code === ProtocolErrorCode.InvalidParams) {
        console.log('Invalid parameters');
    }
}
```

#### New `SdkErrorCode` enum

The new `SdkErrorCode` enum contains string-valued codes for local SDK errors:

| Code                                              | Description                                 |
| ------------------------------------------------- | ------------------------------------------- |
| `SdkErrorCode.NotConnected`                       | Transport is not connected                  |
| `SdkErrorCode.AlreadyConnected`                   | Transport is already connected              |
| `SdkErrorCode.NotInitialized`                     | Protocol is not initialized                 |
| `SdkErrorCode.CapabilityNotSupported`             | Required capability is not supported        |
| `SdkErrorCode.RequestTimeout`                     | Request timed out waiting for response      |
| `SdkErrorCode.ConnectionClosed`                   | Connection was closed                       |
| `SdkErrorCode.SendFailed`                         | Failed to send message                      |
| `SdkErrorCode.InvalidResult`                      | Response result failed local schema validation |
| `SdkErrorCode.ClientHttpNotImplemented`           | HTTP POST request failed                    |
| `SdkErrorCode.ClientHttpAuthentication`           | Server returned 401 after re-authentication |
| `SdkErrorCode.ClientHttpForbidden`                | Server returned 403 after trying upscoping  |
| `SdkErrorCode.ClientHttpUnexpectedContent`        | Unexpected content type in HTTP response    |
| `SdkErrorCode.ClientHttpFailedToOpenStream`       | Failed to open SSE stream                   |
| `SdkErrorCode.ClientHttpFailedToTerminateSession` | Failed to terminate session                 |

#### `StreamableHTTPError` removed

The `StreamableHTTPError` class has been removed. HTTP transport errors are now thrown as `SdkError` with specific `SdkErrorCode` values that provide more granular error information:

**Before (v1):**

```typescript
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

try {
    await transport.send(message);
} catch (error) {
    if (error instanceof StreamableHTTPError) {
        console.log('HTTP error:', error.code); // HTTP status code
    }
}
```

**After (v2):**

```typescript
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/client';

try {
    await transport.send(message);
} catch (error) {
    if (error instanceof SdkError) {
        switch (error.code) {
            case SdkErrorCode.ClientHttpAuthentication:
                console.log('Auth failed — server rejected token after re-auth');
                break;
            case SdkErrorCode.ClientHttpForbidden:
                console.log('Forbidden after upscoping attempt');
                break;
            case SdkErrorCode.ClientHttpFailedToOpenStream:
                console.log('Failed to open SSE stream');
                break;
            case SdkErrorCode.ClientHttpNotImplemented:
                console.log('HTTP request failed');
                break;
        }
        // Access HTTP status code from error.data if needed
        const httpStatus = (error.data as { status?: number })?.status;
    }
}
```

#### Why this change?

Previously, `ErrorCode.RequestTimeout` (-32001) and `ErrorCode.ConnectionClosed` (-32000) were used for local timeout/connection errors. However, these errors never cross the wire as JSON-RPC responses - they are rejected locally. Using protocol error codes for local errors was
semantically inconsistent.

The new design:

- `ProtocolError` with `ProtocolErrorCode`: For errors that are serialized and sent as JSON-RPC error responses
- `SdkError` with `SdkErrorCode`: For local errors that are thrown/rejected locally and never leave the SDK

### OAuth error refactoring

The OAuth error classes have been consolidated into a single `OAuthError` class with an `OAuthErrorCode` enum.

#### Removed classes

The following individual error classes have been removed in favor of `OAuthError` with the appropriate code:

| v1 Class                       | v2 Equivalent                                                     |
| ------------------------------ | ----------------------------------------------------------------- |
| `InvalidRequestError`          | `new OAuthError(OAuthErrorCode.InvalidRequest, message)`          |
| `InvalidClientError`           | `new OAuthError(OAuthErrorCode.InvalidClient, message)`           |
| `InvalidGrantError`            | `new OAuthError(OAuthErrorCode.InvalidGrant, message)`            |
| `UnauthorizedClientError`      | `new OAuthError(OAuthErrorCode.UnauthorizedClient, message)`      |
| `UnsupportedGrantTypeError`    | `new OAuthError(OAuthErrorCode.UnsupportedGrantType, message)`    |
| `InvalidScopeError`            | `new OAuthError(OAuthErrorCode.InvalidScope, message)`            |
| `AccessDeniedError`            | `new OAuthError(OAuthErrorCode.AccessDenied, message)`            |
| `ServerError`                  | `new OAuthError(OAuthErrorCode.ServerError, message)`             |
| `TemporarilyUnavailableError`  | `new OAuthError(OAuthErrorCode.TemporarilyUnavailable, message)`  |
| `UnsupportedResponseTypeError` | `new OAuthError(OAuthErrorCode.UnsupportedResponseType, message)` |
| `UnsupportedTokenTypeError`    | `new OAuthError(OAuthErrorCode.UnsupportedTokenType, message)`    |
| `InvalidTokenError`            | `new OAuthError(OAuthErrorCode.InvalidToken, message)`            |
| `MethodNotAllowedError`        | `new OAuthError(OAuthErrorCode.MethodNotAllowed, message)`        |
| `TooManyRequestsError`         | `new OAuthError(OAuthErrorCode.TooManyRequests, message)`         |
| `InvalidClientMetadataError`   | `new OAuthError(OAuthErrorCode.InvalidClientMetadata, message)`   |
| `InsufficientScopeError`       | `new OAuthError(OAuthErrorCode.InsufficientScope, message)`       |
| `InvalidTargetError`           | `new OAuthError(OAuthErrorCode.InvalidTarget, message)`           |
| `CustomOAuthError`             | `new OAuthError(customCode, message)`                             |

The `OAUTH_ERRORS` constant has also been removed.

**Before (v1):**

```typescript
import { InvalidClientError, InvalidGrantError, ServerError } from '@modelcontextprotocol/client';

try {
    await refreshToken();
} catch (error) {
    if (error instanceof InvalidClientError) {
        // Handle invalid client
    } else if (error instanceof InvalidGrantError) {
        // Handle invalid grant
    } else if (error instanceof ServerError) {
        // Handle server error
    }
}
```

**After (v2):**

```typescript
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/client';

try {
    await refreshToken();
} catch (error) {
    if (error instanceof OAuthError) {
        switch (error.code) {
            case OAuthErrorCode.InvalidClient:
                // Handle invalid client
                break;
            case OAuthErrorCode.InvalidGrant:
                // Handle invalid grant
                break;
            case OAuthErrorCode.ServerError:
                // Handle server error
                break;
        }
    }
}
```

### Experimental: `TaskCreationParams.ttl` no longer accepts `null`

The `ttl` field in `TaskCreationParams` (used when requesting the server to create a task) no longer accepts `null`. Per the MCP spec, `null` TTL (meaning unlimited lifetime) is only valid in server responses (`Task.ttl`), not in client requests. Clients should omit `ttl` to let
the server decide the lifetime.

This also narrows the type of `requestedTtl` in `TaskContext`, `CreateTaskServerContext`, and `TaskServerContext` from `number | null | undefined` to `number | undefined`.

**Before (v1):**

```typescript
// Requesting unlimited lifetime by passing null
const result = await client.callTool({
    name: 'long-task',
    arguments: {},
    task: { ttl: null }
});

// Handler context had number | null | undefined
server.setRequestHandler('tools/call', async (request, ctx) => {
    const ttl: number | null | undefined = ctx.task?.requestedTtl;
});
```

**After (v2):**

```typescript
// Omit ttl to let the server decide (server may return null for unlimited)
const result = await client.callTool({
    name: 'long-task',
    arguments: {},
    task: {}
});

// Handler context is now number | undefined
server.setRequestHandler('tools/call', async (request, ctx) => {
    const ttl: number | undefined = ctx.task?.requestedTtl;
});
```

> **Note:** These task APIs are marked `@experimental` and may change without notice.

## Enhancements

### Automatic JSON Schema validator selection by runtime

The SDK now automatically selects the appropriate JSON Schema validator based on your runtime environment:

- **Node.js**: Uses `AjvJsonSchemaValidator` (same as v1 default)
- **Cloudflare Workers**: Uses `CfWorkerJsonSchemaValidator` (previously required manual configuration)

This means Cloudflare Workers users no longer need to explicitly pass the validator:

**Before (v1) - Cloudflare Workers required explicit configuration:**

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';

const server = new McpServer(
    { name: 'my-server', version: '1.0.0' },
    {
        capabilities: { tools: {} },
        jsonSchemaValidator: new CfWorkerJsonSchemaValidator() // Required in v1
    }
);
```

**After (v2) - Works automatically:**

```typescript
import { McpServer } from '@modelcontextprotocol/server';

const server = new McpServer(
    { name: 'my-server', version: '1.0.0' },
    { capabilities: { tools: {} } }
    // Validator auto-selected based on runtime
);
```

You can still explicitly override the validator if needed:

```typescript
// Runtime-aware default (auto-selects AjvJsonSchemaValidator or CfWorkerJsonSchemaValidator)
import { DefaultJsonSchemaValidator } from '@modelcontextprotocol/server/_shims';

// Specific validators
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker';
```

## Unchanged APIs

The following APIs are unchanged between v1 and v2 (only the import paths changed):

- `Client` constructor and most client methods (`connect`, `listTools`, `listPrompts`, `listResources`, `readResource`, etc.) — note: `callTool()` signature changed (schema parameter removed)
- `McpServer` constructor, `server.connect(transport)`, `server.close()`
- `Server` (low-level) constructor and all methods
- `StreamableHTTPClientTransport`, `SSEClientTransport`, `StdioClientTransport` constructors and options
- `StdioServerTransport` constructor and options
- All Zod schemas and type definitions from `types.ts` (except the aliases listed above)
- Tool, prompt, and resource callback return types

## Using an LLM to migrate your code

An LLM-optimized version of this guide is available at [`docs/migration-SKILL.md`](migration-SKILL.md). It contains dense mapping tables designed for tools like Claude Code to mechanically apply all the changes described above. You can paste it into your LLM context or load it as
a skill.

## Need Help?

If you encounter issues during migration:

1. Check the [FAQ](faq.md) for common questions about v2 changes
2. Review the [examples](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/examples) for updated usage patterns
3. Open an issue on [GitHub](https://github.com/modelcontextprotocol/typescript-sdk/issues) if you find a bug or need further assistance
