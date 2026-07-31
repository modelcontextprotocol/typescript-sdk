# `@modelcontextprotocol/hono`

Hono adapters for the MCP TypeScript server SDK.

This package is a thin Hono integration layer for [`@modelcontextprotocol/server`](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/packages/server).

It does **not** implement MCP itself. Instead, it helps you:

- serve MCP as a single Hono middleware with `mcp(factory)`
- create a Hono app with sensible defaults for MCP servers
- parse JSON request bodies and expose them as `c.get('parsedBody')` for Streamable HTTP transports
- add DNS rebinding protection via Host header validation (recommended for localhost servers)

## Install

```bash
npm install @modelcontextprotocol/server @modelcontextprotocol/hono hono
```

## Exports

- `mcp(factory, options?)` — the one-call way to serve MCP as a Hono middleware
- `createMcpHonoApp(options?)`
- `hostHeaderValidation(allowedHostnames)`
- `localhostHostValidation()`

## Usage

### Serve MCP in one call (recommended)

`mcp(factory)` returns a single Hono middleware that serves MCP over Streamable
HTTP. It builds on `createMcpHandler`, so the endpoint serves the modern
2026-07-28 protocol and falls back to stateless 2025-era serving — a fresh
`McpServer` from your factory backs every request. JSON body parsing and
localhost DNS-rebinding / origin protection are wired for you; mount it on a
route you already own:

```ts
import { mcp } from '@modelcontextprotocol/hono';
import { McpServer } from '@modelcontextprotocol/server';
import { Hono } from 'hono';

const app = new Hono();
app.all(
    '/mcp',
    mcp(() => new McpServer({ name: 'my-server', version: '1.0.0' }))
);
```

Binding to a public interface? Pass `allowedHosts` / `allowedOrigins` the same way
as `createMcpHonoApp`, plus any `createMcpHandler` options under `handler`:

```ts
app.all(
    '/mcp',
    mcp(factory, {
        host: '0.0.0.0',
        allowedHosts: ['api.example.com'],
        handler: { legacy: 'reject' } // modern-only strict
    })
);
```

### Build the app yourself (`createMcpHonoApp`)

When you need full control over routing or want to wire the transport by hand,
`createMcpHonoApp()` returns a `Hono` app with the same defaults pre-applied:

```ts
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';

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
