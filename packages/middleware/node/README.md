# `@modelcontextprotocol/node`

Node.js adapters for the MCP TypeScript server SDK.

This package is a thin Node.js integration layer for [`@modelcontextprotocol/server`](../../server/). It provides a Streamable HTTP transport that works with Node’s `IncomingMessage` / `ServerResponse`.

For web‑standard runtimes (Cloudflare Workers, Deno, Bun, etc.), use `WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/server` directly.

## Install

```bash
npm install @modelcontextprotocol/server @modelcontextprotocol/node
```

## Exports

- `NodeStreamableHTTPServerTransport`
- `StreamableHTTPServerTransportOptions` (type alias for `WebStandardStreamableHTTPServerTransportOptions`)

## Usage

### Express + Streamable HTTP

```ts
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer } from '@modelcontextprotocol/server';

const server = new McpServer({ name: 'my-server', version: '1.0.0' });
const app = createMcpExpressApp();

app.post('/mcp', async (req, res) => {
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);

    // If you use Express JSON parsing, pass the pre-parsed body to avoid re-reading the stream.
    await transport.handleRequest(req, res, req.body);
});
```

### Node.js `http` server

```ts
import { createServer } from 'node:http';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer } from '@modelcontextprotocol/server';

const server = new McpServer({ name: 'my-server', version: '1.0.0' });

createServer(async (req, res) => {
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res);
}).listen(3000);
```
