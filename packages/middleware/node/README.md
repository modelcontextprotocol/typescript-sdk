# @modelcontextprotocol/node

Node.js HTTP adapters for MCP servers. Wraps the Web Standards `HTTPServerTransport` for compatibility with Node.js HTTP types (`IncomingMessage`/`ServerResponse`).

## Installation

```bash
npm install @modelcontextprotocol/node
```

## Exports

- `StreamableHTTPServerTransport` - HTTP transport for Node.js servers
- `SSEServerTransport` - Legacy SSE transport (protocol version 2024-11-05)

## Usage

```typescript
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer } from '@modelcontextprotocol/server';
import http from 'node:http';

const server = new McpServer({ name: 'my-server', version: '1.0.0' });
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => crypto.randomUUID()
});

await server.connect(transport);

http.createServer((req, res) => {
  transport.handleRequest(req, res);
}).listen(3000);
```
