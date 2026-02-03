# Migration Guide: v1 to v2

This guide covers the breaking changes introduced in v2 of the MCP TypeScript SDK and how to update your code.

## Overview

Version 2 of the MCP TypeScript SDK introduces several breaking changes to improve modularity, reduce dependency bloat, and provide a cleaner API surface. The biggest change is the split from a single `@modelcontextprotocol/sdk` package into separate `@modelcontextprotocol/core`, `@modelcontextprotocol/client`, and `@modelcontextprotocol/server` packages.

## Breaking Changes

### Package split (monorepo)

The single `@modelcontextprotocol/sdk` package has been split into three packages:

| v1 | v2 |
|----|-----|
| `@modelcontextprotocol/sdk` | `@modelcontextprotocol/core` (types, protocol, transports) |
| | `@modelcontextprotocol/client` (client implementation) |
| | `@modelcontextprotocol/server` (server implementation) |

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
import { Client, StreamableHTTPClientTransport, StdioClientTransport } from '@modelcontextprotocol/client';
import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import { CallToolResultSchema } from '@modelcontextprotocol/core';

// Node.js HTTP server transport is in the @modelcontextprotocol/node package
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
```

Note: `@modelcontextprotocol/client` and `@modelcontextprotocol/server` both re-export everything from `@modelcontextprotocol/core`, so you can import types from whichever package you already depend on.

### Dropped Node.js 18 and CommonJS

v2 requires **Node.js 20+** and ships **ESM only** (no more CommonJS builds).

If your project uses CommonJS (`require()`), you will need to either:
- Migrate to ESM (`import`/`export`)
- Use dynamic `import()` to load the SDK

### Server decoupled from HTTP frameworks

The server package no longer depends on Express or Hono. HTTP framework integrations are now separate middleware packages:

| v1 | v2 |
|----|-----|
| Built into `@modelcontextprotocol/sdk` | `@modelcontextprotocol/node` (Node.js HTTP) |
| | `@modelcontextprotocol/express` (Express) |
| | `@modelcontextprotocol/hono` (Hono) |

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

### Server auth removed

Server-side OAuth/auth has been removed entirely from the SDK. This includes `mcpAuthRouter`, `OAuthServerProvider`, `OAuthTokenVerifier`, `requireBearerAuth`, `authenticateClient`, `ProxyOAuthServerProvider`, `allowedMethods`, and all associated types.

Use a dedicated auth library (e.g., `better-auth`) or a full Authorization Server instead. See the [examples](../examples/server/src/) for a working demo with `better-auth`.

Note: `AuthInfo` has moved from `server/auth/types.ts` to `@modelcontextprotocol/core` (it's now a core type).

### `Headers` object instead of plain objects

Transport APIs and `RequestInfo.headers` now use the Web Standard `Headers` object instead of plain `Record<string, string | string[] | undefined>` (`IsomorphicHeaders` has been removed).

This affects both transport constructors and request handler code that reads headers:

**Before (v1):**

```typescript
// Transport headers
const transport = new StreamableHTTPClientTransport(url, {
  requestInit: {
    headers: {
      'Authorization': 'Bearer token',
      'X-Custom': 'value',
    },
  },
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
      'Authorization': 'Bearer token',
      'X-Custom': 'value',
    }),
  },
});

// Reading headers in a request handler
const sessionId = extra.requestInfo?.headers.get('mcp-session-id');
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
server.resource('config', 'config://app', async (uri) => {
  return { contents: [{ uri: uri.href, text: '{}' }] };
});
```

**After (v2):**

```typescript
import { McpServer } from '@modelcontextprotocol/server';

const server = new McpServer({ name: 'demo', version: '1.0.0' });

// Tool with schema
server.registerTool('greet', { inputSchema: { name: z.string() } }, async ({ name }) => {
  return { content: [{ type: 'text', text: `Hello, ${name}!` }] };
});

// Tool with description
server.registerTool('greet', { description: 'Greet a user', inputSchema: { name: z.string() } }, async ({ name }) => {
  return { content: [{ type: 'text', text: `Hello, ${name}!` }] };
});

// Prompt
server.registerPrompt('summarize', { argsSchema: { text: z.string() } }, async ({ text }) => {
  return { messages: [{ role: 'user', content: { type: 'text', text: `Summarize: ${text}` } }] };
});

// Resource
server.registerResource('config', 'config://app', {}, async (uri) => {
  return { contents: [{ uri: uri.href, text: '{}' }] };
});
```

### Host header validation moved

Express-specific middleware (`hostHeaderValidation()`, `localhostHostValidation()`) moved from the server package to `@modelcontextprotocol/express`. The server package now exports framework-agnostic functions instead: `validateHostHeader()`, `localhostAllowedHostnames()`, `hostHeaderValidationResponse()`.

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
server.setRequestHandler(InitializeRequestSchema, async (request) => {
  return { protocolVersion: '...', capabilities: {}, serverInfo: { name: '...', version: '...' } };
});

// Notification handler with schema
server.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
  console.log(notification.params.data);
});
```

**After (v2):**

```typescript
import { Server } from '@modelcontextprotocol/server';

const server = new Server({ name: 'my-server', version: '1.0.0' });

// Request handler with method string
server.setRequestHandler('initialize', async (request) => {
  return { protocolVersion: '...', capabilities: {}, serverInfo: { name: '...', version: '...' } };
});

// Notification handler with method string
server.setNotificationHandler('notifications/message', (notification) => {
  console.log(notification.params.data);
});
```

The request and notification parameters remain fully typed via `RequestTypeMap` and `NotificationTypeMap`. You no longer need to import the individual `*RequestSchema` or `*NotificationSchema` constants for handler registration.

Common method string replacements:

| Schema (v1) | Method string (v2) |
|-------------|-------------------|
| `InitializeRequestSchema` | `'initialize'` |
| `CallToolRequestSchema` | `'tools/call'` |
| `ListToolsRequestSchema` | `'tools/list'` |
| `ListPromptsRequestSchema` | `'prompts/list'` |
| `GetPromptRequestSchema` | `'prompts/get'` |
| `ListResourcesRequestSchema` | `'resources/list'` |
| `ReadResourceRequestSchema` | `'resources/read'` |
| `CreateMessageRequestSchema` | `'sampling/createMessage'` |
| `ElicitRequestSchema` | `'elicitation/create'` |
| `LoggingMessageNotificationSchema` | `'notifications/message'` |
| `ToolListChangedNotificationSchema` | `'notifications/tools/list_changed'` |
| `ResourceListChangedNotificationSchema` | `'notifications/resources/list_changed'` |
| `PromptListChangedNotificationSchema` | `'notifications/prompts/list_changed'` |

### Client list methods return empty results for missing capabilities

`Client.listPrompts()`, `listResources()`, `listResourceTemplates()`, and `listTools()` now return empty results when the server didn't advertise the corresponding capability, instead of sending the request. This respects the MCP spec's capability negotiation.

To restore v1 behavior (throw an error when capabilities are missing), set `enforceStrictCapabilities: true`:

```typescript
const client = new Client({ name: 'my-client', version: '1.0.0' }, {
  enforceStrictCapabilities: true,
});
```

### Removed type aliases and deprecated exports

The following deprecated type aliases have been removed from `@modelcontextprotocol/core`:

| Removed | Replacement |
|---------|-------------|
| `JSONRPCError` | `JSONRPCErrorResponse` |
| `JSONRPCErrorSchema` | `JSONRPCErrorResponseSchema` |
| `isJSONRPCError` | `isJSONRPCErrorResponse` |
| `isJSONRPCResponse` | `isJSONRPCResultResponse` |
| `ResourceReferenceSchema` | `ResourceTemplateReferenceSchema` |
| `ResourceReference` | `ResourceTemplateReference` |
| `IsomorphicHeaders` | Use Web Standard `Headers` |
| `AuthInfo` (from `server/auth/types.js`) | `AuthInfo` (now in `@modelcontextprotocol/core`) |

All other types and schemas exported from `@modelcontextprotocol/sdk/types.js` retain their original names in `@modelcontextprotocol/core`.

**Before (v1):**

```typescript
import { JSONRPCError, ResourceReference, isJSONRPCError } from '@modelcontextprotocol/sdk/types.js';
```

**After (v2):**

```typescript
import { JSONRPCErrorResponse, ResourceTemplateReference, isJSONRPCErrorResponse } from '@modelcontextprotocol/core';
```

## Unchanged APIs

The following APIs are unchanged between v1 and v2 (only the import paths changed):

- `Client` constructor and all client methods (`connect`, `callTool`, `listTools`, `listPrompts`, `listResources`, `readResource`, etc.)
- `McpServer` constructor, `server.connect(transport)`, `server.close()`
- `Server` (low-level) constructor and all methods
- `StreamableHTTPClientTransport`, `SSEClientTransport`, `StdioClientTransport` constructors and options
- `StdioServerTransport` constructor and options
- All Zod schemas and type definitions from `types.ts` (except the aliases listed above)
- Tool, prompt, and resource callback return types

## Using an LLM to migrate your code

An LLM-optimized version of this guide is available at [`docs/migration-SKILL.md`](migration-SKILL.md). It contains dense mapping tables designed for tools like Claude Code to mechanically apply all the changes described above. You can paste it into your LLM context or load it as a skill.

## Need Help?

If you encounter issues during migration:

1. Check the [FAQ](faq.md) for common questions about v2 changes
2. Review the [examples](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/examples) for updated usage patterns
3. Open an issue on [GitHub](https://github.com/modelcontextprotocol/typescript-sdk/issues) if you find a bug or need further assistance
