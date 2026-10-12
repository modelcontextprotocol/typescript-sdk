# `@modelcontextprotocol/fastify`

Fastify adapters for the MCP TypeScript server SDK.

This package is a thin Fastify integration layer for [`@modelcontextprotocol/server`](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/packages/server).

It does **not** implement MCP itself. Instead, it helps you:

- create a Fastify app with sensible defaults for MCP servers
- add DNS rebinding protection via Host header validation (recommended for localhost servers)

## Install

```bash
npm install @modelcontextprotocol/server @modelcontextprotocol/fastify fastify

# For MCP Streamable HTTP over Node.js (IncomingMessage/ServerResponse):
npm install @modelcontextprotocol/node
```

## Exports

- `createMcpFastifyApp(options?)`
- `hostHeaderValidation(allowedHostnames)`
- `localhostHostValidation()`

## Usage

### Create a Fastify app (localhost DNS rebinding protection by default)

```ts
import { createMcpFastifyApp } from '@modelcontextprotocol/fastify';

const app = createMcpFastifyApp(); // default host is 127.0.0.1; protection enabled
```

### Streamable HTTP endpoint (Fastify)

```ts
import { createMcpFastifyApp } from '@modelcontextprotocol/fastify';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer } from '@modelcontextprotocol/server';

const app = createMcpFastifyApp();

app.post('/mcp', async (request, reply) => {
    // Stateless example: create a server and a transport per request (with sessions: one pair per session).
    const mcpServer = new McpServer({ name: 'my-server', version: '1.0.0' });
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcpServer.connect(transport);

    // Clean up when the client closes the connection (e.g. during SSE streaming).
    reply.raw.on('close', () => {
        transport.close();
        mcpServer.close();
    });

    await transport.handleRequest(request.raw, reply.raw, request.body);
});
```

To reject non-POST requests with 405 Method Not Allowed, add routes for GET and DELETE that send a JSON-RPC error response.

### Host header validation (DNS rebinding protection)

```ts
import { hostHeaderValidation } from '@modelcontextprotocol/fastify';

app.addHook('onRequest', hostHeaderValidation(['localhost', '127.0.0.1', '[::1]']));
```
