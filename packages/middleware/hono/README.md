# `@modelcontextprotocol/hono`

Hono adapters for the MCP TypeScript server SDK.

This package is a thin Hono integration layer for [`@modelcontextprotocol/server`](../../server/).

It does **not** implement MCP itself. Instead, it helps you:

- create a Hono app with sensible defaults for MCP servers
- parse JSON request bodies and expose them as `c.get('parsedBody')` for Streamable HTTP transports
- add DNS rebinding protection via Host header validation (recommended for localhost servers)

## Install

```bash
npm install @modelcontextprotocol/server @modelcontextprotocol/hono hono
```

## Exports

- `createMcpHonoApp(options?)`
- `hostHeaderValidation(allowedHostnames)`
- `localhostHostValidation()`

## Usage

### Streamable HTTP endpoint (Hono)

```ts
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';

const server = new McpServer({ name: 'my-server', version: '1.0.0' });
const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
await server.connect(transport);

const app = createMcpHonoApp();
app.all('/mcp', c => transport.handleRequest(c.req.raw, { parsedBody: c.get('parsedBody') }));
```

### Host header validation (DNS rebinding protection)

```ts
import { localhostHostValidation } from '@modelcontextprotocol/hono';

const app = createMcpHonoApp();
app.use('*', localhostHostValidation());
```
