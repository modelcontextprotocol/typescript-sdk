# `@modelcontextprotocol/server-hono`

Hono adapters for the MCP TypeScript server SDK.

This package is the Hono-specific companion to [`@modelcontextprotocol/server`](../server/), which is framework-agnostic and uses Web Standard `Request`/`Response` interfaces.

## Install

```bash
npm install @modelcontextprotocol/server @modelcontextprotocol/server-hono hono zod
```

## Exports

- `mcpStreamableHttpHandler(transport)`
- `registerMcpAuthRoutes(app, options)`
- `registerMcpAuthMetadataRoutes(app, options)`
- `hostHeaderValidation(allowedHosts)`
- `localhostHostValidation()`

## Usage

### Streamable HTTP endpoint (Hono)

```ts
import { Hono } from 'hono';
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { mcpStreamableHttpHandler } from '@modelcontextprotocol/server-hono';

const server = new McpServer({ name: 'my-server', version: '1.0.0' });
const transport = new WebStandardStreamableHTTPServerTransport();
await server.connect(transport);

const app = new Hono();
app.all('/mcp', mcpStreamableHttpHandler(transport));
```

### OAuth routes (Hono)

`@modelcontextprotocol/server` provides Web-standard auth handlers; this package mounts them onto a Hono app.

```ts
import { Hono } from 'hono';
import type { OAuthServerProvider } from '@modelcontextprotocol/server';
import { registerMcpAuthRoutes } from '@modelcontextprotocol/server-hono';

const provider: OAuthServerProvider = /* ... */;

const app = new Hono();
registerMcpAuthRoutes(app, {
  provider,
  issuerUrl: new URL('https://auth.example.com')
});
```

### Host header validation (DNS rebinding protection)

```ts
import { Hono } from 'hono';
import { localhostHostValidation } from '@modelcontextprotocol/server-hono';

const app = new Hono();
app.use('*', localhostHostValidation());
```
