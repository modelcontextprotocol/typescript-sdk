# @modelcontextprotocol/express

Express middleware and OAuth server support for MCP.

## Installation

```bash
npm install @modelcontextprotocol/express
```

## Exports

- `createMcpExpressApp()` - Create an Express app with MCP-compatible middleware
- `mcpAuthRouter()` - OAuth 2.0 authorization server router
- `requireBearerAuth()` - Bearer token authentication middleware
- `mcpAuthMetadataRouter()` - Protected resource metadata endpoints

## Usage

```typescript
import { createMcpExpressApp, mcpAuthRouter } from '@modelcontextprotocol/express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer } from '@modelcontextprotocol/server';

const app = createMcpExpressApp();
const server = new McpServer({ name: 'my-server', version: '1.0.0' });

app.post('/mcp', async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(3000);
```
