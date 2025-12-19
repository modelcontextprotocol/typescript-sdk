# Reusing McpServer Instances Across Sessions (Streamable HTTP)

## Quick Answer

**Yes, but with an important caveat.**

The `Protocol` base class (which `Server` and `McpServer` extend) only holds **one `_transport` at a time**. When you call `server.connect(transport)`, it replaces any previous transport. This means:

- ✅ You can reuse one `McpServer` across sequential sessions
- ❌ You **cannot** have multiple concurrent sessions with one `McpServer` instance

## Recommended Patterns

### Pattern 1: Per-Session Server (handles concurrency)

This is what the examples use - create a new server per session but reuse the transport for the same session:

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'crypto';
import { z } from 'zod';

const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string;

  if (sessionId && transports[sessionId]) {
    // Reuse existing transport (server is already connected)
    await transports[sessionId].handleRequest(req, res, req.body);
  } else if (!sessionId && isInitializeRequest(req.body)) {
    // New session - create new server AND transport
    const server = new McpServer({ name: 'my-server', version: '1.0.0' });
    server.tool('my-tool', { param: z.string() }, async ({ param }) => {
      return { content: [{ type: 'text', text: `Hello ${param}` }] };
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID()
    });
    await server.connect(transport);
    transports[transport.sessionId!] = transport;
    await transport.handleRequest(req, res, req.body);
  }
});

// Helper to check for initialize request
function isInitializeRequest(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    'method' in body &&
    (body as { method: string }).method === 'initialize'
  );
}
```

### Pattern 2: Stateless (no sessions)

For simple request/response scenarios where you don't need session persistence:

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

app.post('/mcp', async (req, res) => {
  const server = new McpServer({ name: 'my-server', version: '1.0.0' });
  server.tool('my-tool', { param: z.string() }, async ({ param }) => {
    return { content: [{ type: 'text', text: `Hello ${param}` }] };
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined  // Stateless mode - no session tracking
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
```

### Pattern 3: Shared Server (sequential only)

If you're certain you won't have concurrent sessions:

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'crypto';
import { z } from 'zod';

// Create and configure server ONCE
const sharedServer = new McpServer({ name: 'my-server', version: '1.0.0' });
sharedServer.tool('my-tool', { param: z.string() }, async ({ param }) => {
  return { content: [{ type: 'text', text: `Hello ${param}` }] };
});

const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string;

  let transport: StreamableHTTPServerTransport;
  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID()
    });
    transports[transport.sessionId!] = transport;
    await sharedServer.connect(transport);  // ⚠️ Replaces previous transport!
  }

  await transport.handleRequest(req, res, req.body);
});
```

> ⚠️ **Warning**: Pattern 3 will break if you have concurrent sessions because `connect()` disconnects the previous transport.

## Why Per-Session Servers?

The per-session pattern (Pattern 1) is preferred because:

1. **Concurrency-safe** - Each session has its own server instance
2. **Minimal overhead** - Tool/resource registration is lightweight
3. **Clean state management** - Per-session state and cleanup
4. **Matches architecture** - Respects the 1:1 Protocol-Transport relationship

## Architecture Overview

```
McpServer
  └── Server (extends Protocol)
      └── Protocol._transport  ← Only ONE transport at a time!
```

The `Protocol` class in `src/shared/protocol.ts` has a single `_transport` field. When you call `connect()`, it:
1. Closes the previous transport (if any)
2. Assigns the new transport
3. Sets up message handlers

This design means one server instance = one active session at a time.

## Session Cleanup

Don't forget to clean up sessions when they end:

```typescript
// Handle session termination (DELETE request)
app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string;
  if (sessionId && transports[sessionId]) {
    await transports[sessionId].close();
    delete transports[sessionId];
  }
  res.status(200).end();
});
```

## References

- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Streamable HTTP Example](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/src/examples/server/simpleStreamableHttp.ts)
