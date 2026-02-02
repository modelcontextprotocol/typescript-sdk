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

Install only the packages you need:

```bash
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
import { McpServer } from '@modelcontextprotocol/server';
import { CallToolResultSchema } from '@modelcontextprotocol/core';

// Server-side transports are now in the @modelcontextprotocol/node package (see below)
import { NodeStreamableHTTPServerTransport, StdioServerTransport } from '@modelcontextprotocol/node';
```

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

Server-side OAuth/auth has been removed from the SDK. Use a dedicated auth library (e.g., `better-auth`) or a full Authorization Server instead. See the [examples](../examples/server/src/) for a working demo with `better-auth`.

### `Headers` object instead of plain objects

Transport APIs now use the standard `Headers` object instead of plain `Record<string, string>` objects.

**Before (v1):**

```typescript
const transport = new StreamableHTTPClientTransport(url, {
  requestInit: {
    headers: {
      'Authorization': 'Bearer token',
      'X-Custom': 'value',
    },
  },
});
```

**After (v2):**

```typescript
const transport = new StreamableHTTPClientTransport(url, {
  requestInit: {
    headers: new Headers({
      'Authorization': 'Bearer token',
      'X-Custom': 'value',
    }),
  },
});
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

**Before (v1):**

```typescript
import { JSONRPCError, ResourceReference, isJSONRPCError } from '@modelcontextprotocol/sdk/types.js';
```

**After (v2):**

```typescript
import { JSONRPCErrorResponse, ResourceTemplateReference, isJSONRPCErrorResponse } from '@modelcontextprotocol/core';
```

## Need Help?

If you encounter issues during migration:

1. Check the [FAQ](faq.md) for common questions about v2 changes
2. Review the [examples](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/examples) for updated usage patterns
3. Open an issue on [GitHub](https://github.com/modelcontextprotocol/typescript-sdk/issues) if you find a bug or need further assistance
