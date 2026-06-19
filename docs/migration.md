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

If you need a temporary bridge during migration, `@modelcontextprotocol/server-legacy/sse` provides a frozen copy of the v1 `SSEServerTransport`:

```typescript
import { SSEServerTransport } from '@modelcontextprotocol/server-legacy/sse';
```

This package is deprecated and will not receive new features.

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

Resource Server helpers (`requireBearerAuth`, `mcpAuthMetadataRouter`, `getOAuthProtectedResourceMetadataUrl`, `OAuthTokenVerifier`) are first-class in `@modelcontextprotocol/express`.

Authorization Server helpers (`mcpAuthRouter`, `OAuthServerProvider`, `ProxyOAuthServerProvider`, `authenticateClient`, `allowedMethods`, etc.) have been removed from the core SDK; new code should use a dedicated IdP/OAuth library. See the [examples](../examples/server/src/) for
a working demo with `better-auth`.

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

### Resumability gating for unknown protocol versions (Streamable HTTP server)

The server-side Streamable HTTP transport enables resumability behavior introduced with protocol version `2025-11-25` — SSE priming events and the `closeSSEStream` / `closeStandaloneSSEStream` callbacks — based on the client's protocol version. Previously this was an open-ended
`protocolVersion >= '2025-11-25'` comparison, so an unrecognized future version string in an `initialize` request body (which, unlike the `MCP-Protocol-Version` header, is not validated against the supported-versions list) silently enabled the behavior.

The check is now bounded: the version must be one of the transport's supported protocol versions (after `connect()`, the server's `supportedProtocolVersions`) **and** at least `2025-11-25`. Behavior for all currently supported protocol versions (`2024-10-07` through `2025-11-25`)
is unchanged. Clients claiming an unknown future protocol version in the initialize body are now treated like clients without empty-SSE-data support: no priming event is sent and no early-close callbacks are provided.

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
    return {
        items: [
            /* ... */
        ]
    };
});
```

**After (v2):**

```typescript
const SearchParams = z.object({ query: z.string(), limit: z.number().int() });
const SearchResult = z.object({ items: z.array(z.string()) });

server.setRequestHandler('acme/search', { params: SearchParams, result: SearchResult }, async (params, ctx) => {
    return {
        items: [
            /* ... */
        ]
    };
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

For **spec** methods, the public `Protocol.request()`, `BaseContext.mcpReq.send()`, and `Client.callTool()` methods no longer require a Zod result schema argument. The SDK now resolves the correct result schema internally based on the method name. This means you no longer need to
import result schemas like `CallToolResultSchema` or `ElicitResultSchema` when making spec-method requests.

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

The return type is now inferred from the method name via `ResultTypeMap`. For example, `client.request({ method: 'tools/call', ... })` returns `Promise<CallToolResult>`.

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

// v2: or get the StandardSchemaV1Sync validator object directly
import { specTypeSchemas } from '@modelcontextprotocol/client';
const result = specTypeSchemas.CallToolResult['~standard'].validate(value);
```

`isSpecType` and `specTypeSchemas` are keyed by `SpecTypeName` — a literal union of every named type in the MCP spec — so you get autocomplete and a compile error on typos. `specTypeSchemas.X` is a `StandardSchemaV1Sync<In, Out>` — `validate()` returns the result synchronously,
so you can access `.issues` / `.value` without `await`. It composes with any Standard-Schema-aware library. The pre-existing `isCallToolResult(value)` guard still works.

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

### Client list methods auto-aggregate pagination

`Client.listTools()`, `listPrompts()`, `listResources()`, and `listResourceTemplates()` called **without a `cursor`** now walk every page on your behalf and return the complete aggregated result with `nextCursor: undefined`. This matches the C#, Java, and mcp.d SDKs. Passing an explicit `{ cursor }` string still fetches a single page (the v1 per-page contract).

Existing manual pagination loops keep working — the first iteration returns everything and the loop exits after one pass — but they can now be deleted:

```typescript
// v1 — manual pagination loop
const allTools: Tool[] = [];
let cursor: string | undefined;
do {
    const { tools, nextCursor } = await client.listTools({ cursor });
    allTools.push(...tools);
    cursor = nextCursor;
} while (cursor !== undefined);

// v2 — auto-aggregated
const { tools } = await client.listTools();
```

The auto-aggregate walk is capped at `ClientOptions.listMaxPages` pages (default 64; `0` disables) and throws an `SdkError` with `SdkErrorCode.ListPaginationExceeded` if the server's pagination does not converge, so a partial aggregate is never returned. The cap applies only to the no-`cursor` aggregate path; explicit per-page calls are never capped. The aggregated result is also written to the client's response cache (the source for `callTool`'s output-schema validation and SEP-2243 header mirroring).

### Client honours server cache hints (SEP-2549)

On a 2026-07-28 connection the cacheable verbs — `listTools()`, `listPrompts()`, `listResources()`, `listResourceTemplates()`, and `readResource()` — now serve a still-fresh held entry without a round trip when the server-stamped `ttlMs` has not elapsed. The behaviour is opt-in **by server hint**: a server that sends `ttlMs: 0` (the conservative default the SDK's `McpServer` stamps unless configured otherwise) sees byte-identical behaviour — every call fetches. A `list_changed` notification still evicts immediately regardless of TTL.

Per-call control via the new `CacheableRequestOptions.cacheMode` (`'use'` is the default):

```typescript
await client.listTools(); // serve from cache if fresh
await client.listTools(undefined, { cacheMode: 'refresh' }); // always fetch, then re-store
await client.listTools(undefined, { cacheMode: 'bypass' }); // fetch; do not read or write the cache
```

New `ClientOptions`:

- `cachePartition?: string` — the opaque per-principal identifier for `'private'`-scoped entries (the spec's "MUST NOT share across authorization contexts"). Entries are automatically scoped by connected-server identity (derived from `serverInfo`), so one `responseCacheStore` may back several clients without consumer-side encoding; set `cachePartition` to your principal identifier (e.g. the auth subject) when sharing a store across principals. With the default `''` every entry — public or private — lives at the connected server's shared partition (the safe single-tenant posture). Note `serverInfo` is self-reported, so a server that deliberately impersonates another's `name`/`version` shares its `'public'` slot; the per-principal isolation holds regardless.
- `defaultCacheTtlMs?: number` — applied when a cacheable result lacks `ttlMs` (e.g. a legacy-era response). Default `0` — never serve from cache; the list aggregate is still **stored** so `callTool`'s mirroring/output-validation index keeps working regardless. The server-supplied `ttlMs` is clamped at 24 h (`MAX_CACHE_TTL_MS`).

The `ResponseCacheStore` interface gained `delete(key)` (the per-URI invalidation `notifications/resources/updated` drives) — custom stores written against the alpha substrate need to add it. The default `InMemoryResponseCacheStore` is now bounded (default 512 entries, oldest-first eviction; configurable via `{ maxEntries }`).

**Output-schema validator lifecycle (every era):** validator compilation is now lazy — validators are compiled on the first `callTool()` against the cached `tools/list` entry, not eagerly inside `listTools()`. In v1, `listTools()` threw on an uncompilable `outputSchema`; now
`listTools()` succeeds (every tool stays listed) and the compile failure is captured per-tool. Calling `callTool()` on the affected tool then throws `ProtocolError(InvalidParams, "Tool 'X' has an invalid outputSchema: …")`, **before the request is sent** — output-schema
validation is never silently skipped. A pluggable `jsonSchemaValidator` provider observes compilation at `callTool` time, not `listTools` time. The legacy-era `listTools()` path is unchanged at the wire level but is observably different at the validator-lifecycle level.

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

| v1                                                | v2                                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------- |
| `RequestHandlerExtra` (flat, all fields)          | `ServerContext` (server handlers) or `ClientContext` (client handlers) |
| `extra` parameter name                            | `ctx` parameter name                                                   |
| `extra.signal`                                    | `ctx.mcpReq.signal`                                                    |
| `extra.requestId`                                 | `ctx.mcpReq.id`                                                        |
| `extra._meta`                                     | `ctx.mcpReq._meta`                                                     |
| `extra.sendRequest(...)`                          | `ctx.mcpReq.send(...)`                                                 |
| `extra.sendNotification(...)`                     | `ctx.mcpReq.notify(...)`                                               |
| `extra.authInfo`                                  | `ctx.http?.authInfo`                                                   |
| `extra.requestInfo`                               | `ctx.http?.req` (standard Web `Request`, only on `ServerContext`)      |
| `extra.closeSSEStream`                            | `ctx.http?.closeSSE` (only on `ServerContext`)                         |
| `extra.closeStandaloneSSEStream`                  | `ctx.http?.closeStandaloneSSE` (only on `ServerContext`)               |
| `extra.sessionId`                                 | `ctx.sessionId`                                                        |
| `extra.taskStore` / `taskId` / `taskRequestedTtl` | _removed — see "Experimental tasks interception removed" below_        |

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
    await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: 'abc', progress: 50, total: 100 } });
    return { content: [{ type: 'text', text: 'result' }] };
});
```

Context fields are organized into 3 groups:

- **`mcpReq`** — request-level concerns: `id`, `method`, `_meta`, `signal`, `send()`, `notify()`, plus server-only `log()`, `elicitInput()`, and `requestSampling()`
- **`http?`** — HTTP transport concerns (undefined for stdio): `authInfo`, plus server-only `req`, `closeSSE`, `closeStandaloneSSE`
- **`sessionId?`** — transport session identifier (top-level)

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

The SDK now distinguishes between three types of errors:

1. **`ProtocolError`** (renamed from `McpError`): Protocol errors that cross the wire as JSON-RPC error responses
2. **`SdkError`**: Local SDK errors that never cross the wire (timeouts, connection issues, capability checks)
3. **`SdkHttpError`** (extends `SdkError`): HTTP transport errors with typed `.status` and `.statusText` accessors

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

| Code                                              | Description                                    |
| ------------------------------------------------- | ---------------------------------------------- |
| `SdkErrorCode.NotConnected`                       | Transport is not connected                     |
| `SdkErrorCode.AlreadyConnected`                   | Transport is already connected                 |
| `SdkErrorCode.NotInitialized`                     | Protocol is not initialized                    |
| `SdkErrorCode.CapabilityNotSupported`             | Required capability is not supported           |
| `SdkErrorCode.RequestTimeout`                     | Request timed out waiting for response         |
| `SdkErrorCode.ConnectionClosed`                   | Connection was closed                          |
| `SdkErrorCode.SendFailed`                         | Failed to send message                         |
| `SdkErrorCode.InvalidResult`                      | Response result failed local schema validation |
| `SdkErrorCode.ClientHttpNotImplemented`           | HTTP POST request failed                       |
| `SdkErrorCode.ClientHttpAuthentication`           | Server returned 401 after re-authentication    |
| `SdkErrorCode.ClientHttpForbidden`                | Server returned 403 insufficient_scope after step-up re-authorization (retry cap reached) |
| `SdkErrorCode.ClientHttpUnexpectedContent`        | Unexpected content type in HTTP response       |
| `SdkErrorCode.ClientHttpFailedToOpenStream`       | Failed to open SSE stream                      |
| `SdkErrorCode.ClientHttpFailedToTerminateSession` | Failed to terminate session                    |

#### `StreamableHTTPError` removed

The `StreamableHTTPError` class has been removed. HTTP transport errors are now thrown as `SdkHttpError` (a subclass of `SdkError` with typed `.status` and `.statusText` accessors) with specific `SdkErrorCode` values that provide more granular error information:

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
import { SdkHttpError, SdkErrorCode } from '@modelcontextprotocol/client';

try {
    await transport.send(message);
} catch (error) {
    if (error instanceof SdkHttpError) {
        console.log('HTTP status:', error.status); // number — no cast needed
        console.log('Status text:', error.statusText); // string | undefined
        switch (error.code) {
            case SdkErrorCode.ClientHttpAuthentication:
                console.log('Auth failed — server rejected token after re-auth');
                break;
            case SdkErrorCode.ClientHttpForbidden:
                console.log('403 insufficient_scope after step-up re-authorization (retry cap)');
                break;
            case SdkErrorCode.ClientHttpFailedToOpenStream:
                console.log('Failed to open SSE stream');
                break;
            case SdkErrorCode.ClientHttpNotImplemented:
                console.log('HTTP request failed');
                break;
        }
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
| `InsufficientScopeError`       | `new OAuthError(OAuthErrorCode.InsufficientScope, message)` ¹     |
| `InvalidTargetError`           | `new OAuthError(OAuthErrorCode.InvalidTarget, message)`           |
| `CustomOAuthError`             | `new OAuthError(customCode, message)`                             |

¹ Unrelated to the new transport-layer `InsufficientScopeError` introduced for SEP-2350 — that class carries an RFC 6750 `WWW-Authenticate` challenge from the resource server and does **not** extend `OAuthError`; see [Scope step-up on `403 insufficient_scope`](#scope-step-up-on-403-insufficient_scope-sep-2350).

The `OAUTH_ERRORS` constant has also been removed.

If you need the v1 OAuth error classes and `mcpAuthRouter` during migration, `@modelcontextprotocol/server-legacy/auth` provides a frozen copy:

```typescript
import { mcpAuthRouter, InvalidClientError } from '@modelcontextprotocol/server-legacy/auth';
```

This package is deprecated and will not receive new features. Use a dedicated OAuth provider in production.

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

### Dynamic Client Registration: `application_type` and `grant_types` defaults (SEP-837, SEP-2207)

`OAuthClientMetadata` now has a typed `application_type?: string` field (expected `'native'` / `'web'`; tolerant on parse). `auth()` resolves your provider's `clientMetadata` once via the new `resolveClientMetadata()` and uses the resolved document for the Dynamic Client Registration body (scope selection still reads your raw `clientMetadata`). When `application_type` is unset, it is derived from your `redirect_uris`: a loopback host (`localhost` / `127.0.0.1` / `[::1]`) or a custom URI scheme yields `'native'`; anything else yields `'web'`. Set it explicitly when the heuristic is wrong for your deployment (for example a web app dev-served on `localhost`); a value you set is never overwritten.

`resolveClientMetadata()` also defaults `grant_types` to `['authorization_code', 'refresh_token']` when you omit it, so authorization servers that gate refresh-token issuance on the registered grant types issue one. If you set `grant_types` explicitly, include `'refresh_token'` yourself if you want refresh tokens. CIMD users author the hosted metadata document themselves and should include `refresh_token` there. Direct callers of `registerClient()` that want the same defaults should pass `resolveClientMetadata(provider)` as `clientMetadata`. The `grant_types` default applies to the Dynamic Client Registration body only; it does **not** drive the `offline_access` scope / `prompt=consent` augmentation on the authorize request. Statically-registered and CIMD clients that want that augmentation must set `clientMetadata.grant_types = ['authorization_code', 'refresh_token']` explicitly. Non-interactive providers (no `redirectUrl`) get no `grant_types` default.

DCR rejection now throws `RegistrationRejectedError` (carrying `status`, `body`, and `submittedMetadata`) instead of a generic `OAuthError`. Catch it to inspect the AS's `error` / `error_description` and retry with adjusted metadata, or surface a meaningful error.

```typescript
import { registerClient, RegistrationRejectedError, OAuthErrorCode } from '@modelcontextprotocol/client';

try {
    await registerClient(authorizationServerUrl, { metadata, clientMetadata });
} catch (e) {
    if (e instanceof RegistrationRejectedError) {
        const parsed = JSON.parse(e.body) as { error?: string; error_description?: string };
        if (parsed.error === OAuthErrorCode.InvalidRedirectUri) {
            // AS rejected redirect_uris — retry with adjusted metadata
        }
    }
}
```

### Token endpoint must use TLS (SEP-2207)

`exchangeAuthorization()`, `refreshAuthorization()`, `fetchToken()`, and the Cross-App Access helpers `requestJwtAuthorizationGrant()` / `exchangeJwtAuthGrant()` now throw `InsecureTokenEndpointError` when the resolved token endpoint is not `https:`. Only `localhost`, `127.0.0.1`, and `::1` are exempt for local development. `auth()` surfaces this error on every path (including the refresh branch) rather than silently re-authorizing. If you were pointing at a plain-`http:` authorization server on a non-loopback host — including cluster-DNS names like `http://oauth.svc.cluster.local` or private addresses like `http://10.0.0.5` — switch it to TLS; there is no opt-out.

**Storage confidentiality remains yours.** `OAuthClientProvider.saveTokens()` receives the raw `refresh_token`; store it in platform-appropriate secure storage. The SDK guarantees transit confidentiality but cannot secure your storage layer.

### Experimental tasks interception removed

The 2025-11 experimental tasks side-channel woven through `Protocol` has been removed in preparation for the SEP-2663 Tasks Extension. The following are gone with no in-place replacement:

- `ProtocolOptions.tasks` (the `{ taskStore, taskMessageQueue }` constructor option)
- `protocol.taskManager` getter, `Protocol#_bindTaskManager`
- `RequestOptions.task` / `RequestOptions.relatedTask`, `NotificationOptions.relatedTask`
- `BaseContext.task` (`ctx.task?.store` / `ctx.task?.id` / `ctx.task?.requestedTtl`)
- abstract `assertTaskCapability` / `assertTaskHandlerCapability`
- `client.experimental.tasks.*` / `server.experimental.tasks.*` / `mcpServer.experimental.tasks.*` accessors and the `Experimental{Client,Server,McpServer}Tasks` classes
- streaming methods (`requestStream`, `callToolStream`, `createMessageStream`, `elicitInputStream`) and the `ResponseMessage` types they yielded (`BaseResponseMessage`, `ErrorMessage`, `AsyncGeneratorValue`)
- `mcpServer.experimental.tasks.registerToolTask(...)`, `ToolTaskHandler`, `TaskRequestHandler`, `CreateTaskRequestHandler`
- `TaskMessageQueue`, `InMemoryTaskMessageQueue`, `BaseQueuedMessage` and the `Queued*` message types, `CreateTaskServerContext`, `TaskServerContext`, `TaskToolExecution`
- `examples/{client,server}/src/simpleTaskInteractive*.ts`

**Also removed:** the storage layer (`TaskStore`, `InMemoryTaskStore`, `CreateTaskOptions`, `isTerminal`). It will return as part of the SEP-2663 server-directed plugin in a follow-up.

**Wire types remain, as deprecated vocabulary.** The task wire surface defined by the 2025-11-25 protocol revision is still exported, for interoperability with peers on that revision: the task Zod schemas and their inferred types (`Task`, `TaskStatus`, `TaskMetadata`,
`RelatedTaskMetadata`, `CreateTaskResult`, `GetTask*`, `GetTaskPayload*`, `ListTasks*`, `CancelTask*`, `TaskStatusNotification*`, `TaskAugmentedRequestParams`), the task members of the request/result/notification union types, the `tasks` capability key, the
`isTaskAugmentedRequestParams` guard, and `RELATED_TASK_META_KEY`. These exports are now marked `@deprecated` (importable wire vocabulary only; removable at the major version that drops 2025-era support), and the typed method surface no longer offers task methods:
`RequestMethod`/`RequestTypeMap`/`ResultTypeMap`/`NotificationTypeMap` exclude `tasks/*` and `notifications/tasks/status`, so the method-keyed overloads of `request()`, `ctx.mcpReq.send()`, `setRequestHandler()`, and `setNotificationHandler()` do not accept them (the
explicit-schema overloads still work for custom interop). The method-keyed result types are narrowed to match: `ResultTypeMap['tools/call']` is plain `CallToolResult` (no `| CreateTaskResult`), and likewise `sampling/createMessage` and `elicitation/create` lose their task-result
union members — the runtime result validation uses the same plain schemas, so a task-shaped response body to one of these methods fails as a local `INVALID_RESULT` error where the result schema rejects it rather than parsing into a mis-typed success. Only the behavior is gone:
servers built on this SDK do not advertise the `tasks` capability, and inbound `tasks/*` requests receive a standard `-32601` (method not found) error.

There is no migration path for the removed surface; it was always `@experimental`. Task support is planned to return as an opt-in extension plugin per SEP-2663.

### Wire-only protocol members hidden from the public types

The protocol revision 2026-07-28 introduces wire-level bookkeeping that the SDK handles internally and that never needs to reach application code: the `resultType` result discrimination field, the reserved per-request `_meta` envelope keys
(`io.modelcontextprotocol/protocolVersion`, `io.modelcontextprotocol/clientInfo`, `io.modelcontextprotocol/clientCapabilities`, `io.modelcontextprotocol/logLevel`), and the multi-round-trip retry fields (`inputResponses`, `requestState`). The public TypeScript surface no longer
declares these members:

- **`resultType` is gone from every public result type** (`Result`, `CallToolResult`, `GetPromptResult`, …, and the `result` member of `JSONRPCResultResponse`). The wire schemas keep parsing it, and the protocol layer consumes it before results reach your code. If you previously
  read `result.resultType` (it was always `undefined` from conforming 2025-era peers), drop the read — the SDK now owns that field.
- **High-level methods return the named public types.** `client.callTool()` returns `Promise<CallToolResult>`, `client.listTools()` returns `Promise<ListToolsResult>`, and so on (previously these returned structurally inferred schema types that exposed `resultType?`). Handler
  return positions are unaffected: results you build keep type-checking, and unknown members still pass through the loose index signature.
- **The reserved envelope keys and retry fields never appear in a public params/result type.** The `RequestMetaEnvelope` type and the four `*_META_KEY` constants stay exported — they document the wire names and type the context surfacing channel (see below).

The protocol layer enforces the same boundary at runtime:

- **Envelope lift.** On inbound requests and notifications, the reserved `io.modelcontextprotocol/*` envelope keys are lifted out of `params._meta` before handlers run, so handler params are byte-equal to the 2025-era shape under 2026-era traffic. For requests the envelope is
  readable at `ctx.mcpReq.envelope` (typed `Partial<RequestMetaEnvelope>` — only the keys the request actually carried are present); for notifications there is no per-message context, so lifted envelope keys are dropped, not surfaced. On requests only, the multi-round-trip retry
  fields are likewise lifted out of top-level params and surfaced verbatim at `ctx.mcpReq.inputResponses` / `ctx.mcpReq.requestState`; notification params are never touched.
- **What this means for 2025-era peers.** The `_meta` side of the lift is invisible to conforming 2025-era traffic: the `io.modelcontextprotocol/` prefix is reserved in 2025-11-25 too, so a conforming 2025 peer never puts application data under those keys. The retry-field lift is
  the one collision to know about: 2025-11-25 does not reserve the bare names `inputResponses`/`requestState`, so a 2025 peer's **custom-method request** that happens to use them as ordinary top-level params will have them lifted out of the handler's view (still readable at
  `ctx.mcpReq.inputResponses` / `ctx.mcpReq.requestState`, just no longer in `request.params`). Spec-method requests are unaffected (no 2025 spec method defines params with those names), as are all notifications.
- **Raw-first result discrimination.** The client funnel inspects a response's raw `resultType` before schema validation: `'complete'` is consumed (stripped) and the result parses as the public shape; `'input_required'` is fulfilled by the client's multi-round-trip engine (see
  "Multi round-trip requests" below); any other kind rejects with a typed local error — `SdkError` with the new code `SdkErrorCode.UnsupportedResultType` and the kind in `error.data.resultType` — instead of being masked into a hollow success by tolerant result schemas.
- **`MessageExtraInfo.classification`** is an optional carrier (`{ era, revision?, envelope? }`) for transports that classify inbound messages at the edge. The wire era itself is connection state (the negotiated protocol version held by the `Client`/`Server` instance); dispatch
  validates a classified message against that era and treats a mismatch as an entry/routing error (see the next section).

### Per-era wire codecs: physical deletions and stricter wire schemas

The wire layer is now split into per-revision codecs inside the (private, bundled) core: one codec serves every 2025-era protocol version (2024-10-07 … 2025-11-25) and one serves 2026-07-28. The codec is selected by the negotiated protocol version, which is connection state on
the `Client`/`Server` instance: the client stores it when its initialize handshake completes, the server stores it when it answers `initialize`, and instances with no negotiated version default to the 2025 era (with the pre-negotiation lifecycle messages routed by method:
`initialize`/`notifications/initialized` are 2025-era vocabulary, `server/discover` is 2026-era vocabulary). An edge classification (`MessageExtraInfo.classification`) no longer switches the era per message — it is validated against the instance era, and a mismatch is rejected as
an entry/routing error (`-32022 Unsupported protocol version` for requests, a drop plus `onerror` for notifications). Methods deleted by a protocol revision are now PHYSICALLY absent from that era's registry: an inbound `tasks/get` on a 2026-era connection gets `-32601` even if a
handler is registered, and sending an era-mismatched spec method (for example `server/discover` toward a 2025-era peer, or any `tasks/*` method toward a 2026-era peer) throws a typed local error — `SdkError` with the new code `SdkErrorCode.MethodNotSupportedByProtocolVersion` —
before anything reaches the transport.

Alongside the split, the following deliberate wire-behavior changes ship (each is invisible to conforming peers but observable to direct schema consumers and misbehaving peers):

- **`resultType` is no longer modeled by any neutral wire schema.** The base `ResultSchema` (and every result schema derived from it) no longer declares the optional `resultType` member. Consequences:
    - `EmptyResultSchema` (strict) now REJECTS `{resultType: ...}` bodies where it previously accepted them. On the protocol path nothing changes for conforming peers: the 2026-era codec consumes the field, and the 2025-era codec strips a foreign `resultType` before validation
      (tolerate-and-drop — a 2025-era peer that sends it is misbehaving).
    - On a 2025-era connection, a response carrying a non-`'complete'` `resultType` is no longer rejected with `UnsupportedResultType`: the field is foreign vocabulary on that era and is stripped before validation (the result then passes or fails validation on its actual content,
      loudly). On a 2026-era exchange the discrimination is stricter than before: `resultType` is REQUIRED, an absent value is a spec violation surfaced as a typed error, and `input_required` / unknown kinds reject with `UnsupportedResultType` / `InvalidResult`.
- **`CallToolResult.content` and `ToolResultContent.content` are required at the wire boundary.** The `content.default([])` affordance was removed (it could silently convert unrecognized result shapes into hollow `{content: []}` successes). Tool handlers MUST include `content` in
  their results (the TypeScript surface always required it — `content: []` is fine); a handler result without it is now rejected with `-32602 Invalid tools/call result` instead of being silently defaulted, and a content-less wire result fails the client-side parse loudly.
- **Custom (3-arg) handlers receive `_meta`.** `setRequestHandler(method, {params}, handler)` / `setNotificationHandler(method, {params}, handler)` used to DELETE `params._meta` before validating with your schema. They now pass it through minus the reserved
  `io.modelcontextprotocol/*` envelope keys (which the protocol layer lifts out), making custom methods consistent with spec methods. If your params schema is strict (rejects unknown keys), add an optional `_meta` member or strip it yourself.
- **`specTypeSchemas` validate the neutral model.** Result entries no longer accept/declare `resultType`; the validators for the 2025-only task message types (`Task`, `TaskStatus`, `GetTask*`, `ListTasks*`, `CancelTask*`, `CreateTaskResult`, `TaskStatusNotification*`,
  `TaskCreationParams`) and for `RequestMetaEnvelope` left the public set (`SpecTypeName` narrowed accordingly). Per-revision wire validators are planned to return as versioned `zod-schemas/<revision>` exports.
- **Role aggregate types no longer carry task vocabulary.** `ClientRequest`, `ClientResult`, `ClientNotification`, `ServerRequest`, `ServerResult`, and `ServerNotification` (and their union schemas) are now the neutral message sets; the task members moved into the internal
  2025-era wire module. The individual `Task*` types remain importable (deprecated) exactly as before.
- **Value guards are consumer-side checks, not wire validators.** `isCallToolResult` and friends now validate the neutral shapes; a raw wire object carrying `resultType` still passes them through the loose index signature. Validate raw wire traffic with a transport-level parse,
  not the guards.

**Before:**

```typescript
// A handler omitting content was silently defaulted on the wire:
server.setRequestHandler('tools/call', async () => {
    return { structuredContent: { ok: true } } as CallToolResult; // wire: content []
});

// Custom handlers never saw _meta:
protocol.setRequestHandler('acme/op', { params: z.strictObject({ x: z.number() }) }, async params => ({}));
```

**After:**

```typescript
// content is required (as the spec always said):
server.setRequestHandler('tools/call', async () => {
    return { content: [], structuredContent: { ok: true } };
});

// Custom handlers receive _meta minus the reserved envelope keys:
protocol.setRequestHandler('acme/op', { params: z.strictObject({ x: z.number(), _meta: z.record(z.string(), z.unknown()).optional() }) }, async params => ({}));
```

## Enhancements

### Opt-in protocol version negotiation (2026-07-28 draft)

The client can now negotiate the protocol era at connect time. This is **opt-in**: if you do nothing, `connect()` performs exactly the same 2025 `initialize` handshake as before, byte for byte.

```typescript
import { Client } from '@modelcontextprotocol/client';

// Auto-negotiate: try the 2026-07-28 draft revision, fall back to the 2025
// handshake automatically when the server is a 2025-era deployment.
const client = new Client({ name: 'my-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
await client.connect(transport);

client.getNegotiatedProtocolVersion(); // e.g. '2026-07-28' or '2025-11-25'
```

How the modes behave:

- **absent / `mode: 'legacy'`** (default): today's behavior, unchanged. No probe, no new headers.
- **`mode: 'auto'`**: `connect()` first sends a single `server/discover` probe. A modern server answers it and no `initialize` is sent; a 2025-era server rejects it (deployed servers answer fast, e.g. `-32601` or a `400`), and the client falls back to the plain legacy handshake
  **on the same connection** — byte-equivalent to a 2025 client, including the `initialize` body version and with zero 2026 headers. The probe costs one round trip against an old server and nothing else.
- **`mode: { pin: '2026-07-28' }`**: modern era at exactly that revision. No fallback — if the server does not offer the pinned version, `connect()` rejects with a typed error. Use `pin` where a silent downgrade would be worse than an error (tests, CI, servers you control).

Failure semantics under `'auto'` are deliberately conservative but never silent about infrastructure problems: anything the probe does not positively recognize as modern falls back to the legacy era — provided the supported-versions list still contains a 2025-era revision; with a
modern-only list there is nothing to fall back to and `connect()` rejects with the typed negotiation error instead — while a network outage rejects with a typed connect error (`SdkError` with `EraNegotiationFailed`). A probe timeout is transport-aware, following the
specification's backward-compatibility rules: on **stdio**, a server that does not answer the probe within the timeout is treated as a legacy server (some legacy servers never respond to unknown pre-`initialize` requests at all) and the client falls back to `initialize` on the
same stream; on **HTTP**, where a deployed server answers and silence means an outage, the timeout rejects with a typed `RequestTimeout` error — a dead HTTP server is never misreported as a legacy server. One browser-specific exception: an opaque CORS/preflight `TypeError` during
the probe falls back to the legacy era, because deployed 2025 servers commonly have CORS allow-lists that predate the 2026 headers and the legacy handshake sends none of them.

Probe policy is configured under `versionNegotiation.probe`:

```typescript
versionNegotiation: {
    mode: 'auto',
    probe: {
        timeoutMs: 10_000, // default: the standard request timeout
        maxRetries: 0 // default: no retries — governs timeout re-sends only
    }
}
```

`maxRetries` governs timeout re-sends only (the spec-mandated `-32022` corrective continuation — select-and-continue with a mutual version — is a separate negotiation step and is never counted against it). Negotiation can also be configured pre-connect on an already-constructed
instance via `client.setVersionNegotiation(options)` (equivalent to the constructor option; throws after connecting).

A gateway or worker fleet can skip the probe entirely: probe once, persist `client.getDiscoverResult()` (round-trips through `JSON.stringify`), and pass it to every worker as `client.connect(transport, { prior })` for a **zero-round-trip** connect. `prior` is 2026-07-28+ only —
no modern overlap throws `SdkError(EraNegotiationFailed)`. Only reuse across clients presenting the same authorization context. See `examples/gateway/`.

Once a modern era is negotiated, the client **automatically attaches the per-request `_meta` envelope** (the reserved protocol-version / client-info / client-capabilities keys) to every outgoing request and notification — you never set it by hand. Any `_meta` keys you pass in a
request are preserved over the auto-attached ones. After connect, `client.getProtocolEra()` returns `'legacy'` or `'modern'` and `client.getNegotiatedProtocolVersion()` the exact revision.

On the server side, `server/discover` (advertising only the modern revisions) is served by instances hosted through one of the 2026-era serving entries; a hand-constructed `Server`/`McpServer` is byte-identical to before (it keeps answering `-32601`, and the `initialize`
handshake only ever negotiates 2025-era versions — a 2026-era revision is never accepted or counter-offered there). Serving the 2026 revision to ordinary HTTP traffic is done with the `createMcpHandler` entry point described in the next section; serving it on stdio (and other
long-lived connections) is the `serveStdio` entry point described after that. The client can also issue `client.discover()` directly on a 2026-era connection; on a 2025-era connection the method is rejected locally with a typed error, since it does not exist on that protocol
revision.

### Serving the 2026-07-28 draft revision over HTTP: `createMcpHandler`

The server package now ships an HTTP entry point that serves the 2026-07-28 draft revision per request and, **by default, also serves 2025-era traffic** per request through the established stateless idiom — one factory, one endpoint, both eras:

```typescript
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';

const handler = createMcpHandler(ctx => {
    const server = new McpServer({ name: 'my-server', version: '1.0.0' }, { capabilities: { tools: {} } });
    // register tools/resources/prompts once — the same factory backs both eras
    return server;
});

// Web-standard runtimes (Cloudflare Workers, Deno, Bun, Hono):
//   export default handler;            // or handler.fetch(request)
// Node frameworks (Express, Fastify, plain node:http) — wrap once:
//   import { toNodeHandler } from '@modelcontextprotocol/node';
//   const node = toNodeHandler(handler, { onerror: console.error });
//   app.all('/mcp', (req, res) => void node(req, res, req.body));
```

`toNodeHandler` accepts an optional `{ onerror }` callback that receives the adapter-level error fallback (request conversion / `handler.fetch` throw) before the `500` response is written — entry-internal failures continue to surface through the entry's own `onerror` option.

How the `legacy` option behaves:

- **omitted / `legacy: 'stateless'`** (the default) — 2025-era (non-envelope) traffic is served per request through the established stateless idiom: a fresh instance from the same factory and a streamable HTTP transport constructed with only `sessionIdGenerator: undefined`.
  Because this serving is per-request and stateless, GET and DELETE (2025 session operations) are answered `405` / `Method not allowed.`, exactly like the canonical stateless example. The exported `legacyStatelessFallback(factory)` is the same serving as a standalone fetch-shaped
  handler for hand-wired compositions.
- **`legacy: 'reject'`** — modern-only strict. 2026-07-28 (per-request `_meta` envelope) requests are served; 2025-era requests are rejected with `-32022` naming the supported revisions, and 2025-era notifications are acknowledged with `202` and dropped. **There is no 2025
  serving in this mode.**

> **If you have an existing sessionful 1.x Streamable HTTP setup** (a `StreamableHTTPServerTransport` wiring with session IDs that your deployed 2025-era clients depend on), keep that handler serving 2025 traffic and route it in front of a strict (`legacy: 'reject'`) entry with
> the exported `isLegacyRequest(request)` predicate. The predicate is the entry's own classification step (the same code `createMcpHandler` runs to decide a request is not on the modern path), so a composition that branches on it can never disagree with the entry:
>
> ```typescript
> // An existing sessionful 1.x streamable HTTP wiring keeps serving 2025 clients, routed in front of a strict entry.
> import { createMcpHandler, isLegacyRequest } from '@modelcontextprotocol/server';
>
> const modern = createMcpHandler(factory, { legacy: 'reject' });
>
> export default {
>     async fetch(request: Request): Promise<Response> {
>         if (await isLegacyRequest(request)) {
>             return myExistingLegacyHandler(request); // e.g. an existing sessionful WebStandardStreamableHTTPServerTransport wiring
>         }
>         return modern.fetch(request);
>     }
> };
> ```
>
> `isLegacyRequest` returns `true` only for requests with no per-request `_meta` envelope claim (claim-less POSTs including `initialize`, GET/DELETE session operations, all-legacy batches, posted responses, and non-JSON bodies). It returns `false` for everything the modern path
> answers — including a request carrying a **malformed** modern claim, which the modern path rejects with `-32602` — so route `false` traffic to the modern handler, never to your legacy handler. The predicate classifies a clone, so the request body stays readable for whichever
> handler you route to (pass an already-parsed body as the second argument if the stream has been consumed).

The optional `responseMode` controls how modern request exchanges are answered: `'auto'` (default) returns a single JSON body and lazily upgrades to an SSE stream when the handler emits a related message before its result; `'sse'` always streams; **`'json'` never streams and
DROPS mid-call notifications** (progress, logging, and any other related message emitted before the result) — only the terminal result is delivered. Subscription (listen-class) streams are always served over SSE regardless of the setting. `onerror` receives out-of-band errors and
rejected requests for logging.

The entry performs no Origin/Host validation (see the origin-validation middleware below) and no token verification: `authInfo` passed to `handler.fetch(request, { authInfo })` is forwarded to handlers as-is and never derived from request headers (the Node adapter forwards
`req.auth` to that same option). Power users who want to compose routing themselves can use the exported `isLegacyRequest`, `classifyInboundRequest` and `PerRequestHTTPServerTransport` building blocks directly; `handler.fetch` is a bound property, so it can be detached and
passed around (`const { fetch } = handler`).

### `Mcp-Param-*` request-metadata headers (SEP-2243, 2026-07-28 draft)

On a 2026-07-28 connection over Streamable HTTP, `Client.callTool()` mirrors tool arguments designated with `x-mcp-header` in the tool's `inputSchema` into `Mcp-Param-{Name}` HTTP request headers (Base64-sentinel-encoded where needed) so HTTP intermediaries can route on them
without parsing the body, and `createMcpHandler` rejects a `tools/call` whose `Mcp-Param-*` headers are missing for a present body value, malformed, or disagree with the body — `400 Bad Request` with JSON-RPC `-32020` (`HeaderMismatch`). The legacy-era serving paths and the
client's legacy-era `callTool`/`listTools` are unchanged at the wire level.

The Streamable HTTP transport now also emits the `Mcp-Name` standard header on every modern-enveloped request (`tools/call`/`prompts/get` → `params.name`; `resources/read` → `params.uri`), sentinel-encoded the same way, so intermediaries can route on the resource name without
parsing the body. **On a modern-enveloped request only**, an HTTP `400` whose body is a well-formed JSON-RPC error response addressed to the pending request id is now delivered in-band as a `ProtocolError` (so the `HEADER_MISMATCH` recovery retry can fire); a legacy-era
exchange still surfaces `400` as the existing `SdkHttpError`, so `e instanceof SdkHttpError && e.status === 400` callers are unchanged.

Two additive options support this: `CallToolRequestOptions.toolDefinition` (pass the tool definition directly so mirroring and output-schema validation run without a prior `tools/list`) and `TransportSendOptions.headers` (per-request HTTP headers; the Streamable HTTP transport
skips the reserved standard/auth header names so a per-request header cannot override `mcp-protocol-version`/`mcp-method`/`mcp-name`/`mcp-session-id`/`authorization`; transports that share a single channel — stdio, in-memory — ignore it). On a non-stdio modern connection,
`Client.listTools()` (and the client's internal `tools/list` cache) exclude tool definitions whose `x-mcp-header` declarations violate the spec's constraints, logging a warning naming the tool and the reason. Browser clients skip mirroring (dynamically named headers cannot be
statically allow-listed for credentialed CORS); calling an `x-mcp-header` tool with a non-null designated argument from a browser against a conforming SEP-2243 server is therefore a known limitation.

On the modern path, `createMcpHandler` also validates the SEP-2243 **standard** request-metadata headers against the body and rejects with the same `400` / `-32020` (`HeaderMismatch`) when the `MCP-Protocol-Version` or `Mcp-Method` header disagrees with the body, when the
required `Mcp-Method` header is absent, when the required `Mcp-Name` header is absent on a `tools/call` / `prompts/get` / `resources/read` request, and when the (Base64-sentinel-decoded) `Mcp-Name` value disagrees with `params.name` / `params.uri`. These checks only fire on the
modern (2026-07-28) serving path — 2025-era traffic is unchanged — and a hand-built modern HTTP request must carry the `Mcp-Method` (and where applicable `Mcp-Name`) header; the SDK client already sends them.

### Serving the 2026-07-28 draft revision on stdio: `serveStdio`

The server package ships a stdio entry point that mirrors `createMcpHandler` for long-lived connections: the entry owns the transport and the era decision, the client's opening exchange selects the era for the connection, and ONE instance from your factory is pinned to that
connection and serves only that era.

```typescript
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

serveStdio(() => {
    const server = new McpServer({ name: 'my-server', version: '1.0.0' }, { capabilities: { tools: {} } });
    // register tools/resources/prompts once — the same factory serves both eras
    return server;
});
```

How the connection's era is decided:

- A plain 2025 client opens with the `initialize` handshake (or any request without the per-request `_meta` envelope): the connection is pinned to a 2025-era instance and served exactly as a hand-wired stdio server serves it today. Pass `legacy: 'reject'` to refuse 2025-era
  openings instead — they are answered with the unsupported-protocol-version error naming the supported modern revisions, and there is no silent 2025 serving.
- A 2026-capable client opens with requests carrying the per-request `_meta` envelope: the connection is pinned to a 2026-era instance.
- A `server/discover` probe is answered (from an instance built with your factory, so the advertisement reflects your real server definition) without pinning the connection: the client either continues with enveloped modern requests — pinning the connection to the 2026 era — or
  falls back to `initialize` when it shares no modern revision with the advertisement, in which case the probe instance is discarded and a fresh 2025-era instance serves the handshake. Once the modern era is pinned, a later `initialize` is rejected with the
  unsupported-protocol-version error naming the supported revisions.

Because the entry may construct an instance for a probe that is later discarded (and `createMcpHandler` constructs one per request), factories should be cheap and side-effect-free. Bring your own transport with the `transport` option (for example a `StdioServerTransport` over a
Unix domain socket or TCP stream); by default the entry serves the current process's stdio. The returned handle's `close()` tears down the pinned instance and the transport.

Directionality follows the connection's era: the 2026-07-28 revision has no server→client JSON-RPC request channel, so handlers serving a 2026-pinned connection cannot emit `sampling`/`elicitation`/`roots` wire requests (they fail locally with a typed error), while a 2025-pinned
connection keeps today's behavior. Symmetrically, a client whose connection negotiated a modern era drops inbound JSON-RPC requests instead of answering them.

**The v1 stdio pattern keeps working and stays 2025-only.** A hand-constructed `Server`/`McpServer` connected directly to a `StdioServerTransport` — the way every v1 stdio server is written — still works and serves only the 2025-era protocol it was written for: upgrading the SDK
changes nothing about what it puts on the wire, and no per-instance option turns such a server into a 2026-era server. Serving the 2026-07-28 revision (or both eras) on stdio always goes through `serveStdio`. To migrate an existing v1 stdio server, move its construction into the
factory: replace `await server.connect(new StdioServerTransport())` with `serveStdio(() => buildServer())`, registering tools/resources/prompts inside the factory as before — and pass `{ legacy: 'reject' }` if 2025-era clients should be refused instead of served.

### Cache fields and cache hints for cacheable 2026-07-28 results

The 2026-07-28 revision requires `ttlMs` and `cacheScope` on the cacheable results (`tools/list`, `prompts/list`, `resources/list`, `resources/templates/list`, `resources/read`, `server/discover`). When serving that revision, the SDK now always emits both fields, defaulting to
`ttlMs: 0` and `cacheScope: 'private'` — the most conservative policy, equivalent to "do not cache". To advertise a real cache policy:

```typescript
const server = new McpServer(
    { name: 'my-server', version: '1.0.0' },
    {
        capabilities: { tools: {}, resources: {} },
        // per-operation hints, used when a result does not carry its own values
        cacheHints: { 'tools/list': { ttlMs: 60_000, cacheScope: 'public' } }
    }
);

// per-resource hint for that resource's resources/read results
server.registerResource('config', 'config://app', { cacheHint: { ttlMs: 5_000 } }, async uri => ({
    contents: [{ uri: uri.href, text: '…' }]
}));
```

Resolution is per field, most specific author first: for each of `ttlMs` and `cacheScope`, a value returned by the handler itself (when valid) wins over the per-resource `cacheHint`, which wins over `ServerOptions.cacheHints[operation]`, which wins over the default — so a
per-resource hint that sets only one field never suppresses the other field configured at the operation level. Configured hints are validated when they are configured — an invalid `ttlMs` (negative or non-integer) or `cacheScope` throws a `RangeError`. Responses on 2025-era
connections never carry these fields, with or without configuration.

### `subscriptions/listen` (2026-07-28): change-notification streams replace unsolicited delivery

The 2026-07-28 revision delivers `tools/prompts/resources` `list_changed` and `resources/updated` only on a `subscriptions/listen` stream the client opened — the server never sends an un-requested notification type. Both halves ship:

**Server side.** Nothing to register: the serving entries handle `subscriptions/listen` themselves. `createMcpHandler` returns `.notify.{toolsChanged, promptsChanged, resourcesChanged, resourceUpdated(uri)}` typed publish sugar over an in-process bus (supply your own
`ServerEventBus` for multi-process deployments). On stdio, `serveStdio` routes the pinned instance's existing `send*ListChanged()` calls onto the active subscriptions automatically. The 2025-era unsolicited delivery model is unchanged on legacy connections.

```typescript
const handler = createMcpHandler(() => buildServer());
// after a tool registration changes:
handler.notify.toolsChanged();
```

**Client side.** `ClientOptions.listChanged` keeps working: on a 2026-07-28 connection the SDK auto-opens a `subscriptions/listen` stream whose filter is the intersection of the configured sub-options and the server-advertised `listChanged` capabilities, so the same handlers fire
on every published change (the auto-opened subscription is exposed at `client.autoOpenedSubscription` for `close()`; when the intersection is empty auto-open is skipped and `autoOpenedSubscription` stays `undefined`). `client.listen(filter)` opens a stream explicitly and resolves
once the server's acknowledged notification arrives with `{ honoredFilter, close(), closed }` (where `closed` is a `Promise<'local' | 'remote'>` that resolves once on termination — `'remote'` means the server cancelled, the stream ended, or the transport dropped, so re-listen if
you still want events); change notifications dispatch to the existing `setNotificationHandler` registrations. `resources/subscribe` is 2025-only — on a 2026-07-28 connection, request `notifications/resources/updated` via the `resourceSubscriptions` field of the listen filter
instead.

### Client cancellation on Streamable HTTP (2026-07-28): stream-close is the signal

On a 2026-07-28 Streamable HTTP connection, aborting an in-flight client request (caller `signal` or timeout) now closes that request's SSE response stream — the spec cancellation signal for this transport — instead of POSTing a `notifications/cancelled` message. Nothing to change in calling code: `RequestOptions.signal` and `timeout` behave exactly as before. Cancellation on a 2025-era
connection, and on stdio at any era, is unchanged and still sends `notifications/cancelled`. Custom `Transport` implementations that open one underlying request per outbound JSON-RPC request and honor `TransportSendOptions.requestSignal` may opt into the same routing by declaring
`readonly hasPerRequestStream = true`.

### `ctx.mcpReq.log()`: request-related delivery and the 2026-07-28 per-request opt-in

`ctx.mcpReq.log()` now emits its `notifications/message` request-related (it rides the in-flight exchange like progress and `ctx.mcpReq.notify`) on **every** era. On a 2025-era sessionful Streamable HTTP transport this moves handler-emitted logs from the standalone GET stream onto the per-request POST response stream — a spec-conformance correction: the 2025-11-25 specification (`docs/specification/2025-11-25/basic/transports.mdx` §"Sending Messages to the Server" item 6 / §"Listening for Messages from the Server" item 4) says messages on the POST response stream SHOULD relate to the originating client request and messages on the GET stream SHOULD be unrelated to any concurrently-running request. The session-scoped `logging/setLevel` filter applies as before on 2025-era connections, and an unset session level continues to mean no filter.

On a 2026-07-28 request, `ctx.mcpReq.log()` reads the per-request level filter from the `io.modelcontextprotocol/logLevel` `_meta` envelope key (the modern replacement for the `logging/setLevel` RPC, which is not a request method on that revision). When the key is **absent** the server emits no `notifications/message` for that request — absence is opt-out, not "no filter". The SDK `Client` does not auto-attach a `logLevel` key, so handler logs on a default 2026-era exchange are silently suppressed until the client opts in.

### Multi round-trip requests (2026-07-28): write-once handlers and the client auto-fulfilment driver

The 2026-07-28 revision removes the server→client JSON-RPC request channel: servers obtain client input (elicitation, sampling, roots) **in-band**, by answering `tools/call`, `prompts/get`, or `resources/read` with an `input_required` result that embeds the requests, and the
client retries the original call with the responses. The SDK ships both halves:

**Server side — return `inputRequired(...)` instead of pushing requests.** A handler for one of the three multi-round-trip methods requests input by returning the value built by `inputRequired()` (with the per-kind constructors `inputRequired.elicit`, `inputRequired.elicitUrl`,
`inputRequired.createMessage`, `inputRequired.listRoots`), and reads the responses on re-entry from `ctx.mcpReq.inputResponses` (the `acceptedContent()` helper reads an accepted form elicitation). Hand-built `resultType: 'input_required'` literals are equally legal.

```typescript
const confirmSchema = { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] } as const;

server.registerTool('deploy', { inputSchema: z.object({ env: z.string() }) }, async ({ env }, ctx) => {
    const confirmed = acceptedContent<{ confirm: boolean }>(ctx.mcpReq.inputResponses, 'confirm');
    if (!confirmed?.confirm) {
        return inputRequired({
            inputRequests: { confirm: inputRequired.elicit({ message: `Deploy to ${env}?`, requestedSchema: confirmSchema }) }
        });
    }
    return { content: [{ type: 'text', text: `deployed to ${env}` }] };
});
```

The in-band return is only legal toward 2026-07-28 requests. **A handler that serves both eras branches on the served era**: 2025-era handlers keep using the push-style APIs (`ctx.mcpReq.elicitInput`, `ctx.mcpReq.requestSampling`, instance-level
`createMessage()`/`elicitInput()`/`listRoots()`), and modern handlers return `inputRequired(...)` — an `input_required` return on a 2025-era request fails as a server-side internal error rather than reaching the wire mis-typed. URL elicitation on the 2026-07-28 era is expressed
with `inputRequired.elicitUrl(...)` (correlation across retries belongs in `requestState`); throwing the 1.x `UrlElicitationRequiredError` on a 2026-era request fails loudly with a clear steer to that constructor (it is not converted), while 2025-era serving keeps today's
`-32042` behavior exactly.

On 2026-era requests the push-style APIs (`ctx.mcpReq.send` of server→client requests, `ctx.mcpReq.elicitInput`, `ctx.mcpReq.requestSampling`, and the instance-level `server.createMessage()`/`elicitInput()`/`listRoots()`/`ping()` on modern-bound instances) fail with a typed local
error before anything reaches the wire; in a tool handler the error surfaces to the caller as an `isError` result whose text steers to returning `inputRequired(...)`. Their behavior toward 2025-era requests is unchanged. The error surface differs per family exactly as it always
has: only `tools/call` has a catch-all that wraps handler failures into `isError` results — errors thrown by `prompts/get` and `resources/read` handlers (including the loud failures of the seam guards) surface as JSON-RPC errors.

**`requestState` is untrusted input — protect it yourself.** `inputRequired({ requestState })` lets a server round-trip opaque state through the client instead of holding it in memory. The SDK treats it as an opaque string end to end: the client echoes it back byte-exact and
never parses it, and the server sees the echoed value raw at `ctx.mcpReq.requestState`. The specification's requirement is the consumer's obligation: the value comes back as **attacker-controlled input**, so if it influences authorization, resource access, or business logic you
MUST integrity-protect it when minting it (for example HMAC or AEAD over the payload, bound to the principal, the originating method/parameters, and an expiry) and MUST reject state that fails verification on re-entry. The SDK does not apply any sealing of its own, but it does
provide the place to put your verification — configure `ServerOptions.requestState.verify`, and the seam runs it before the handler whenever `requestState` is present; a thrown rejection answers the client with a frozen `-32602` (above the tool funnel, so it is a real JSON-RPC
error rather than an `isError` result) — and an opt-in helper to drop into it: `createRequestStateCodec({ key, ttlSeconds?, bind? })` returns `{ mint, verify }` where `mint` HMAC-SHA256-seals a JSON-serializable payload (with a TTL, default 600 s, and optional context binding)
and `verify` is exactly the function you assign to the hook. The handler reads its payload back with the same `verify` (`await codec.verify(ctx.mcpReq.requestState, ctx)`) — re-calling `verify` from the handler is the intended pattern (the seam already proved integrity; the
second call is the decode). The codec is **signed, not encrypted**: the body is integrity-protected but the client can base64url-decode it and read the payload in clear, so do not put secrets in the payload — use an AEAD construction if confidentiality is required (the optional
`bind` value is stored as a keyed HMAC tag, not raw, so a principal identifier in the binding does not leak). The codec is WebCrypto-based and runtime-neutral; the key must be at least 32 bytes and shared across every instance that may receive an echoed value. Verification is
fail-closed: any failure (bad MAC, expired, bind mismatch, malformed) throws with a fixed opaque reason code — the seam relays that code to `onerror` only (never the wire), and the code never carries decoded payload or binding values, so operator logs do not pick up principal
identifiers from rejections. See `examples/mrtr/server.ts` for a worked end-to-end example.

**Client side — auto-fulfilment by default.** When a call to `tools/call`, `prompts/get`, or `resources/read` on a 2026-07-28 connection answers `input_required`, the client fulfils the embedded requests through the same handlers registered with
`setRequestHandler('elicitation/create' | 'sampling/createMessage' | 'roots/list', …)` and retries the original request (fresh request id, `inputResponses`, byte-exact `requestState` echo) up to `inputRequired.maxRounds` rounds (default 10). `client.callTool()` and its siblings
keep returning their plain result types — the interactive rounds happen inside the call, and a registered handler written for the 2025 flow keeps working unchanged. Configure or opt out via `ClientOptions.inputRequired` (`{ autoFulfill: false }`), drive the flow manually per call
with the `allowInputRequired: true` request option plus the `withInputRequired()` schema wrapper, and expect the typed `InputRequiredRoundsExceeded` error when the round cap is exhausted. 2025-era connections are unaffected (the legacy wire has no `input_required` vocabulary).

### Resource not found is `-32602` on every revision; typed `ResourceNotFoundError`

`resources/read` for an unknown URI now answers with JSON-RPC error code **`-32602` (Invalid Params)** on every protocol revision, with `error.data.uri` echoing the requested URI. The 2026-07-28 specification requires `-32602`; the v1.x SDK already emitted `-32602` on earlier
revisions, so v1.x peers see no change. An interim `-32002` emission that shipped in earlier v2 alphas is reverted: the era encode seam maps any handler-thrown `-32002` to `-32602` on the wire; note that a `-32002` thrown without `data.uri` is emitted as a bare `-32602` and is no longer recognizable as resource-not-found — throw `ResourceNotFoundError` (or include `data: { uri }`) to preserve the classification.

`ProtocolErrorCode.ResourceNotFound` (`-32002`) **remains importable** as receive-tolerated vocabulary: clients should accept both `-32602` and `-32002` from peers (the specification's backwards-compatibility clause). The new typed `ResourceNotFoundError` class carries the URI on
`.uri`, and `ProtocolError.fromError` reconstructs it from a `-32602` only when `error.data` is exactly `{ uri: string }` (and nothing else), and from a legacy `-32002` whenever `data.uri` is a string (a bare `-32002` without `data.uri` stays a generic `ProtocolError`) — recognize peers' errors by their code and `error.data`, not by `instanceof`, which does not survive
bundling. Servers must not return an empty `contents` array for a non-existent resource (an empty array is ambiguous between "exists but empty" and "does not exist").

```typescript
import { ProtocolError, ResourceNotFoundError } from '@modelcontextprotocol/client';

try {
    await client.readResource({ uri: 'file:///nope' });
} catch (error) {
    // fromError reconstructs the typed class from code + data alone, so this
    // works even when `error` crossed a bundle boundary and `instanceof` on
    // the thrown object would not match.
    const e = error as ProtocolError;
    if (ProtocolError.fromError(e.code, e.message, e.data) instanceof ResourceNotFoundError) {
        console.log('not found:', (e.data as { uri: string }).uri);
    }
}
```

### Typed `-32021` missing-client-capability error

`MissingRequiredClientCapabilityError` is the typed error class for the 2026-07-28 `-32021` protocol error: processing a request requires a capability the client did not declare in the request's `clientCapabilities`. Its `data.requiredCapabilities` lists the missing capabilities,
and `ProtocolError.fromError` recognizes the code/data shape (recognize peers' errors by their code and `error.data`, not by `instanceof`). When the HTTP entry refuses such a request, the response uses HTTP status `400` as the specification requires. The multi-round-trip seam
answers with the same error when a handler embeds an input request (for example an elicitation) that the request's declared client capabilities do not cover.

> **Draft-only renumber**: the 2026-07-28 protocol error codes (`HeaderMismatch`, `MissingRequiredClientCapability`, `UnsupportedProtocolVersion`) were renumbered upstream from `-32001`/`-32003`/`-32004` to `-32020`/`-32021`/`-32022` between v2 alpha builds. These codes have only
> ever appeared on the draft 2026-07-28 wire, so there is **no v1.x → v2 migration impact** — but code written against an earlier v2 alpha that hard-coded the old numeric values must update to the new ones (or, preferably, use the exported `ProtocolErrorCode` enum members /
> `HEADER_MISMATCH_ERROR_CODE` constant).

### Client identity accessors deprecated in favor of per-request context

`Server.getClientCapabilities()`, `Server.getClientVersion()` and `Server.getNegotiatedProtocolVersion()` are deprecated (they remain functional). On 2026-07-28 requests the client's identity travels with each request in the validated `_meta` envelope and is available to handlers
as `ctx.mcpReq.envelope`; instances serving that revision through `createMcpHandler` are backfilled per request, so existing code that calls the accessors keeps working on both eras. On 2025-era connections the accessors keep returning the `initialize`-scoped values, as before.

On a connection pinned to the 2026-07-28 era by `serveStdio` the identity accessors are **not** backfilled: the modern era carries client identity per request, so connection-scoped identity has nothing stable to report there. `getClientCapabilities()` and `getClientVersion()`
return `undefined` (no `initialize` handshake ever ran on such a connection) and handlers read the per-request identity from `ctx.mcpReq.envelope`. `getNegotiatedProtocolVersion()` reports the pinned revision (`2026-07-28`) — the entry era-marks the instance when it binds it, so
the accessor reports the same value as on instances serving that revision through `createMcpHandler`. On 2025-pinned connections the accessors keep their `initialize`-scoped semantics, as before.

### Origin validation middleware and default arming

The middleware packages now ship Origin header validation alongside the existing Host header validation, and the app factories arm it by default for localhost-class binds:

```typescript
import { originValidation, localhostOriginValidation } from '@modelcontextprotocol/express'; // also @modelcontextprotocol/hono, /fastify

const app = createMcpExpressApp(); // localhost bind: Host AND Origin validation armed by default
const appCustom = createMcpExpressApp({ host: '0.0.0.0', allowedHosts: ['myapp.local'], allowedOrigins: ['myapp.local'] });
```

Requests without an `Origin` header pass unchanged (MCP clients outside a browser do not send one), so non-browser traffic is unaffected. A present `Origin` whose hostname is not allowed — or that cannot be parsed, including the opaque `null` origin — is rejected with `403` (deny
on failure). For a localhost-bound factory app there is no switch that turns Origin validation off: passing an explicit `allowedOrigins` list replaces the default localhost allowlist (use it to allow additional origins, such as a deployed web frontend), and validation stays
armed. The framework-agnostic helpers (`validateOriginHeader`, `localhostAllowedOrigins`, `originValidationResponse`) live in `@modelcontextprotocol/server` for bare web-standard mounts, and `@modelcontextprotocol/node` now ships request guards (`hostHeaderValidation`,
`originValidation` and their `localhost*` variants) for plain `node:http` servers, which previously had no validation helpers.

### Automatic JSON Schema validator selection by runtime

The SDK now automatically selects the appropriate JSON Schema validator based on your runtime environment:

- **Node.js**: Uses AJV (same as v1 default)
- **Cloudflare Workers**: Uses `@cfworker/json-schema` (previously required manual configuration)

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

You do not need to install or import validator packages for the default behavior. The client and server packages bundle the validator backend selected by the runtime shim, so a normal `import { McpServer } from '@modelcontextprotocol/server'` does not pull `ajv` or
`@cfworker/json-schema` into your bundle until you choose to customize.

If you want to customize the **built-in** backend (for example, pre-register schemas by `$id`, register custom AJV formats, or change the `@cfworker/json-schema` draft), import the named class from the explicit subpath and pass an instance through `jsonSchemaValidator`:

```typescript
import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';

const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);

const server = new McpServer(
    { name: 'my-server', version: '1.0.0' },
    {
        capabilities: { tools: {} },
        jsonSchemaValidator: new AjvJsonSchemaValidator(ajv)
    }
);
```

```typescript
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker';

const server = new McpServer(
    { name: 'my-server', version: '1.0.0' },
    {
        capabilities: { tools: {} },
        jsonSchemaValidator: new CfWorkerJsonSchemaValidator({ draft: '2020-12', shortcircuit: false })
    }
);
```

(both subpaths are also available on `@modelcontextprotocol/client/validators/...`)

If you import from one of these subpaths in your own code, the corresponding peer dep (`ajv` + `ajv-formats`, or `@cfworker/json-schema`) needs to be installed in your `package.json`. The runtime shim continues to vendor a copy for the default code path, so you can use the
subpath in some files and rely on the default in others.

To replace validation wholesale rather than customizing the built-in classes, implement the `jsonSchemaValidator` interface and pass your own implementation through the option above.

### JSON Schema 2020-12 posture (SEP-1613, SEP-2106)

SEP-1613 (in the 2025-11-25 revision) declares JSON Schema **draft 2020-12** as the dialect for tool `inputSchema` / `outputSchema`, and SEP-2106 (2026-07-28 draft) widens both to the full 2020-12 vocabulary — `$defs`, `$ref`, `$anchor`, composition (`allOf`/`anyOf`/`oneOf`),
conditionals (`if`/`then`/`else`), `prefixItems`, `unevaluatedProperties` — and lifts the `type:"object"` root restriction on `outputSchema` and `structuredContent`. This SDK release brings the validator posture and the public types into line with both SEPs.

#### Default validator is JSON Schema 2020-12 only

The default validator supports **JSON Schema 2020-12 only** (the spec's only MUST). On Node it is now `Ajv2020` (`ajv/dist/2020`) instead of the draft-07 `Ajv` class; the Cloudflare Workers default was already 2020-12. Schemas declaring a different `$schema` are rejected with a
clear `Error("…unsupported dialect … 2020-12 only…")`. Nothing in your code changes unless you fall into one of three populations:

- **You declared 2020-12 keywords (`$defs`, `prefixItems`, `unevaluatedProperties`, `dependentRequired`) in a server schema and they were silently ignored.** They are now enforced. If a previously "passing" tool input or output starts failing validation, the schema was always
  wrong on the wire — fix the schema or the data.
- **You authored draft-07 idioms via `fromJsonSchema()`** (e.g. tuple `items: [...]` instead of `prefixItems`, draft-07 `definitions`). Port to 2020-12 spelling, or pass a draft-07 Ajv instance **as the second argument** — `fromJsonSchema(schema, new AjvJsonSchemaValidator(ajv))` — built per the opt-back recipe below. The `McpServer`/`Client` `jsonSchemaValidator` option does **not** reach `fromJsonSchema()`-authored schemas (`fromJsonSchema()` compiles eagerly with the package-level default unless a validator is passed directly).
- **You imported `Ajv` from the SDK's validator subpath and relied on the re-export being the draft-07 class.** It still is — `Ajv` remains the draft-07 class (re-exported for the opt-back), but it is **no longer** what the SDK uses by default.

To validate other dialects, pass a pre-configured Ajv instance:

```typescript
import { Ajv, addFormats, AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';

// Opt back to the v1 (draft-07) default — accepted structurally; the $schema check is skipped.
const ajv = new Ajv({ strict: false, validateFormats: true, validateSchema: false, allErrors: true });
addFormats(ajv);
const server = new McpServer({ name: 'my-server', version: '1.0.0' }, { jsonSchemaValidator: new AjvJsonSchemaValidator(ajv) });
```

#### External `$ref` is not dereferenced — use `#/$defs/…` or `#anchor`

The SDK never dereferences external `$ref`/`$dynamicRef` (the spec MUST-NOT is "do not dereference", not "reject"). Neither built-in engine fetches: Ajv throws a `MissingRefError` at compile time on an unresolved external reference; `@cfworker/json-schema` leaves it
unresolved. This is unchanged from v1 — there is no new break here. What is new is that on the client, one tool whose schema the engine refuses to compile **does not poison `tools/list`**: every tool stays listed, and the compile failure surfaces lazily when `callTool` is
invoked on that tool, as `ProtocolError(InvalidParams, "Tool 'X' has an invalid outputSchema: …")`, before the request is sent. To author a reusable subschema, inline it under `$defs` and reference it with a same-document `#/$defs/Name` or `#anchor` fragment — those compile and
validate on both built-in engines.

#### `CallToolResult.structuredContent` is now typed `unknown`

SEP-2106 lifts the `type:"object"` root restriction on `outputSchema`, so `structuredContent` may legally be an array, a string, a number, a boolean, or `null`. The public TypeScript type is widened from `{ [key: string]: unknown }` to `unknown` to match. **This is a deliberate
source-level break** for typed consumers that previously indexed into `structuredContent` directly: that worked because the v1 type let you read any key as `unknown`, which was already a lie about what the value at that key was. `unknown` is the honest type for a generic host
that does not know the server's output schema at compile time — narrow at the call site:

```typescript
const r = await client.callTool({ name: 'compute', arguments: { n: 7 } });

// SEP-2106 narrowing pattern: prove the shape, then read.
const sc = r.structuredContent;
if (typeof sc === 'object' && sc !== null && 'value' in sc && typeof sc.value === 'number') {
    use(sc.value);
}
```

The presence check is `!== undefined`, not falsy: `null`, `0`, `false`, `""` are legal `structuredContent` values now and are validated against the tool's `outputSchema` like any other value (so a falsy value against an object-typed schema still fails — this is **not** a guard
weakening). Runtime validation against the cached `outputSchema` remains the safety net regardless of how you narrow on the TypeScript side.

#### Non-object `outputSchema` and the legacy `{result:…}` wrap

A tool may now register an `outputSchema` whose root is `type:"array"`, `type:"string"`, etc. Because the 2025-11-25 wire keeps `outputSchema`/`structuredContent` at their object/Record shapes for byte-identity, a non-object root is **2026-only vocabulary**. When such a tool is
listed toward a 2025-era client, the **2025 wire codec** wraps the `outputSchema` in a `{type:"object", properties:{result:<natural schema>}, required:["result"]}` envelope so legacy clients can parse and compile it; same-document `$ref` / `$dynamicRef` JSON Pointers inside the
natural schema are rewritten (`#` → `#/properties/result`, `#/…` → `#/properties/result/…`) so they keep resolving after the wrap; the rewrite is position-aware (a property **named** `default`/`const` under `properties`/`$defs` is recursed into as a subschema, while the
**keyword** `default`/`const` is left as instance data) and `$id`-scoped (a natural schema or subtree carrying `$id` keeps its refs unrewritten — they resolve against the embedded base, not the wrapper root). On `tools/call` toward the same 2025-era client, `structuredContent`
is wrapped as `{result:<value>}` whenever the value is non-object (array/primitive/`null`) — the 2025 wire shape requires an object — **and** whenever the advertised schema has a non-object root, so the result satisfies the wrapped schema and a `z.union([z.object(...), z.string()])`
outputSchema wraps **both** branches as `{result:…}` on the 2025 era. 2026-era clients see the natural schema and the natural value — no envelope. The wrap lives in the wire codec, so it applies whether you registered the tool through `McpServer` or set a low-level `tools/list`
handler on `Server` directly; for low-level `tools/call` handlers, route the result through `server.projectCallToolResult(result, advertisedOutputSchemaJson)` to get the matching `structuredContent` wrap. This matches the C# SDK's `TransformOutputSchemaForLegacyWire` behavior.

Independently, **on every era** (the SEP's MUST applies regardless of client version), when a handler returns non-object `structuredContent` and no `type:"text"` content of its own, the codec's `projectCallToolResult` auto-appends `{ type: "text", text: JSON.stringify(structuredContent) }`
so consumers that read only `content` still receive a rendering — author any `text` block yourself to opt out.

**Typeless-root output schemas are only stamped `type:"object"` when provably safe.** A Standard-Schema value whose JSON Schema root has no `type` — for example `z.union([z.string(), z.number()])` (`{anyOf:[…]}`), `z.any()` (`{}`), or `z.object({…}).nullable()` — is advertised
as-is on the 2026 era and wrapped in `{result:…}` on the 2025 projection, because stamping `type:"object"` there would produce a self-contradictory schema that rejects every value. The SDK still defaults `type:"object"` when the root carries object keywords
(`properties`/`patternProperties`/`additionalProperties`/`required`) **or** is a `oneOf`/`anyOf`/`allOf` whose every member is `type:"object"` — so `z.discriminatedUnion(...)`, `z.union([z.object(...), …])`, and `z.intersection(...)` of objects keep their 2025-era advertisement
unchanged.

## Specification clarifications adopted (no SDK behavior change)

The 2026-07-28 specification revision includes a number of documentation-only clarifications that do not change SDK wire behavior or public surface. They are recorded here so an audit of the revision's changelog against this guide is complete; nothing in this section requires
code changes.

- **Timeouts** — the specification's per-operation timeout guidance section was removed; the SDK's `RequestOptions.timeout` and `DEFAULT_REQUEST_TIMEOUT_MSEC` are unchanged.
- **stdio shutdown** — the specification clarifies stdio shutdown/termination wording; `StdioServerTransport`/`StdioClientTransport` close semantics are unchanged.
- **Transports as bindings** — the specification reframes transports as bindings of one protocol; the SDK's `Transport` interface is unchanged.
- **`resources/read` clarifications** — wording-only; behavior unchanged. The `file://` path-sanitization MUST is server-author guidance: a resource handler that resolves `file://` URIs to real paths is responsible for rejecting traversal (`..`) and symlink escapes itself — the SDK does not interpose on the path.
- **`PromptMessage` resource links** — `ContentBlock` already includes `ResourceLink` on every revision; no change.
- **Completion `ref/resource` URI templates** — documentation alignment; the SDK's `completion/complete` handling is unchanged.
- **Pagination cursors** — the specification clarifies that an empty-string cursor is a valid opaque cursor; the SDK already passes `cursor` through verbatim (it is `z.string().optional()`).
- **Sampling** — documentation of host requirements; no SDK surface change.
- **Elicitation** — the specification relaxes elicitation statefulness wording and removes a rate-limiting SHOULD; no SDK surface change.
- **Cosmetic schema/JSDoc sweeps** — phrasing alignment with the draft specification; the per-revision generated reference types remain pinned to the specification anchor.

## Unchanged APIs

The following APIs are unchanged between v1 and v2 (only the import paths changed):

- `Client` constructor and most client methods (`connect`, `listTools`, `listPrompts`, `listResources`, `readResource`, etc.) — note: `callTool()` signature changed (schema parameter removed)
- `McpServer` constructor, `server.connect(transport)`, `server.close()`
- `Server` (low-level) constructor and all methods
- `StreamableHTTPClientTransport`, `SSEClientTransport`, `StdioClientTransport` constructors and options
- `StdioServerTransport` constructor and options
- All Zod schemas and type definitions from `types.ts` (except the aliases listed above)
- Tool, prompt, and resource callback return types

**Session-ID mismatch responses**: when session management is enabled and a request carries an `Mcp-Session-Id` header that doesn't match the active session, the Streamable HTTP server transport responds `404 Not Found` with a JSON-RPC error body using code `-32001` and message
`Session not found` — unchanged from v1. Note that this use of `-32001` is an SDK convention, not a spec-assigned error code, and it is expected to be re-derived as error handling for the 2026 protocol revision (`2026-07-28`) is adopted. Avoid hard-coding the `-32001` code in
client logic; key off the HTTP `404` status instead.

## Authorization (2026-07-28 spec)

The 2026-07-28 protocol revision adds client-side authorization requirements (RFC 9207 `iss` validation, RFC 8414 §3.3 issuer-echo, per-authorization-server credential isolation, scope step-up, DCR `application_type`, and refresh-token guidance). The SDK adds the public surface for these now and will implement the parts that land in SDK code (defaulting them on) as the SEP-2468/2352/2350/837/2207 behavior changes land; the parts that live in your `OAuthClientProvider` implementation, your `clientMetadata`, or your host UI are listed under [Conformance obligations for `OAuthClientProvider` implementers](#conformance-obligations-for-oauthclientprovider-implementers).

### `auth()` options are now `AuthOptions`

The inline options object on `auth()` is now the named `AuthOptions` type, exported from `@modelcontextprotocol/client`. Existing call sites need no change. New fields (both currently inert — the validation behavior they feed lands in the follow-up changes tracked by SEP-2468):

- `iss?: string` — the form-urldecoded `iss` query parameter from the authorization callback. Pass it alongside `authorizationCode`; it is forwarded to RFC 9207 issuer validation once that lands.
- `skipIssuerMetadataValidation?: boolean` — opt-out for the RFC 8414 §3.3 issuer-echo check during discovery. **Security-weakening**; use only with authorization servers known to publish a mismatched `issuer`.

### `OAuthClientProvider` credential methods receive an `issuer` context

`clientInformation(ctx?)`, `saveClientInformation(info, ctx?)`, `tokens(ctx?)`, and `saveTokens(tokens, ctx?)` now receive an optional `OAuthClientInformationContext` parameter carrying `{ issuer: string }` — the authorization server's `issuer` identifier. Providers that persist credentials should key storage by this value so that credentials registered with one authorization server are never sent to another. Providers with a single credential set may ignore the parameter; existing implementations compile unchanged. The SDK does not yet pass this argument; it begins doing so when the SEP-2352 behavior change lands.

New TypeScript-only aliases `StoredOAuthTokens` and `StoredOAuthClientInformation` add an optional `issuer?: string` field on top of the wire types and are used as the parameter/return types of `tokens()` / `saveTokens()` and `clientInformation()` / `saveClientInformation()`. The `issuer` field is **not** part of the RFC 6749/7591 wire responses and is intentionally absent from `OAuthTokensSchema` / `OAuthClientInformationSchema` so an authorization server cannot populate it; once the SEP-2352 behavior change lands the SDK will stamp it onto credentials before calling `saveTokens` / `saveClientInformation`. Provider implementations should round-trip it unchanged. The field is currently inert.

### Authorization-server mix-up defense (RFC 9207 / RFC 8414 §3.3)

**Action required for hosts handling OAuth callbacks.**

`transport.finishAuth()` and `auth()` now validate the `iss` parameter from the authorization callback against the issuer recorded from the authorization server's validated metadata (RFC 9207). A **mismatched** `iss` is rejected with `IssuerMismatchError` before the code is exchanged regardless of what the AS advertised; a **missing** `iss` is rejected only when the AS advertised `authorization_response_iss_parameter_supported: true`.

**You must** pass the callback URL's query parameters to the SDK so it can read `iss` alongside `code`. The SDK does **not** validate `state`; compare it to your stored value before calling `finishAuth`:

```typescript
const params = new URL(callbackUrl).searchParams;
if (params.get('state') !== expectedState) throw new Error('state mismatch');
await transport.finishAuth(params); // SDK reads `code` + `iss`
```

`transport.finishAuth(code, iss)` remains supported for back-compat. If you bypass `auth()` and call `exchangeAuthorization()` / `fetchToken()` directly, pass `iss` in the options bag — the same validation runs there.

**You must not** display or act on `error`, `error_description`, or `error_uri` from the callback URL when `IssuerMismatchError` is thrown — those values are attacker-controlled in a mix-up attack. The `URLSearchParams` overload handles this for you; if you parse the callback yourself, suppress them.

_(`@modelcontextprotocol/server-legacy` AS implementers — **behavior change**)_ `mcpAuthRouter()` now advertises `authorization_response_iss_parameter_supported` (default `true`) and the bundled authorize handler appends `iss` to **every** redirect — success or error — that your `OAuthServerProvider.authorize()` issues to the client's `redirect_uri` **via `res.redirect(...)` on the supplied `res`**. No provider change is required when that is how you redirect. If you emit the `Location` header another way (e.g. `res.writeHead(302, { Location })`), issue the final callback redirect from a different response (e.g. after a separate consent-page POST), or wire a standalone `authorizationHandler({provider})` without `issuerUrl`, append `params.issuer` as `iss` yourself — otherwise RFC 9207-compliant clients (including this SDK's) will reject the callback with `IssuerMismatchError`. If the callback is issued by an upstream AS you proxy to, set `authorizationResponseIssParameterSupported = false` on your provider (`ProxyOAuthServerProvider` does this) so the metadata does not over-claim.

`discoverAuthorizationServerMetadata()` now rejects metadata whose `issuer` does not exactly match the URL it was fetched for (RFC 8414 §3.3). If you connect to a known-misconfigured AS, set `skipIssuerMetadataValidation: true` on `StreamableHTTPClientTransportOptions` / `SSEClientTransportOptions` (or on `AuthOptions` if you call `auth()` directly, or `skipIssuerValidation: true` on the low-level helper) — **this weakens the mix-up defense and should be treated as a temporary workaround.** It suppresses only the metadata-echo check; the callback-`iss` validation always runs (and degrades to a no-op only when `iss` is absent and the AS does not advertise support).

### Scope step-up on `403 insufficient_scope` (SEP-2350)

`StreamableHTTPClientTransport` now accepts `onInsufficientScope: 'reauthorize' | 'throw'` (default **`'reauthorize'`**, matching the previous unconditional behavior).

On `'reauthorize'` the transport re-authorizes with the **union** of the previously-requested scope and the challenged scope (new exported helper `computeScopeUnion`), so previously-granted permissions are not lost on step-up. When that union is a strict superset of the current token's granted scope (`isStrictScopeSuperset`), the SDK **bypasses the refresh-token branch** and forces a fresh authorization request — the refresh grant cannot widen scope (RFC 6749 §6), so refreshing would silently drop the new scope. When the token already covers the union, refresh is used as before.

On `'throw'` the transport raises `InsufficientScopeError { requiredScope, resourceMetadataUrl, errorDescription }` and does not re-authorize. Set `'throw'` for `client_credentials` / m2m clients where re-authorization cannot widen scope, and for interactive clients that need to gate the consent prompt behind UX.

If you pass a non-OAuth `authProvider` (or only `requestInit` headers), a `403 insufficient_scope` now throws `InsufficientScopeError` instead of the previous generic `SdkHttpError(ClientHttpNotImplemented)` ("Error POSTing to endpoint: …") — `InsufficientScopeError` extends `Error`, not `SdkError`, so existing `instanceof SdkError` catches no longer match this case. Catch `InsufficientScopeError` explicitly, or set `onInsufficientScope: 'throw'` to make the contract explicit.

Step-up retries are now hard-capped per send (`maxStepUpRetries`, default 1) regardless of `WWW-Authenticate` header content — the previous verbatim-header equality guard is gone. The cap is per request; cross-request "(resource, operation) already failed" tracking is host state.

`AuthOptions` gains `forceReauthorization?: boolean` for hosts driving step-up themselves.

The GET listen-stream open path now applies the same step-up handling as the POST send path.

### Conformance obligations for `OAuthClientProvider` implementers

<!-- Filled in as the SEP-2352/2350/837/2207 behavior PRs land. -->

## Using an LLM to migrate your code

An LLM-optimized version of this guide is available at [`docs/migration-SKILL.md`](migration-SKILL.md). It contains dense mapping tables designed for tools like Claude Code to mechanically apply all the changes described above. You can paste it into your LLM context or load it as
a skill.

## Need Help?

If you encounter issues during migration:

1. Check the [FAQ](faq.md) for common questions about v2 changes
2. Review the [examples](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/examples) for updated usage patterns
3. Open an issue on [GitHub](https://github.com/modelcontextprotocol/typescript-sdk/issues) if you find a bug or need further assistance
