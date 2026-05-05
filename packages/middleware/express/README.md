# `@modelcontextprotocol/express`

Express adapters for the MCP TypeScript server SDK.

This package is a thin Express integration layer for [`@modelcontextprotocol/server`](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/packages/server).

It does **not** implement MCP itself. Instead, it helps you:

- create an Express app with sensible defaults for MCP servers
- add DNS rebinding protection via Host header validation (recommended for localhost servers)
- protect routes with `requireBearerAuth` (validates `Authorization: Bearer …` via your `OAuthTokenVerifier`)
- serve OAuth Protected Resource Metadata (RFC 9728) via `mcpAuthMetadataRouter`

## Install

```bash
npm install @modelcontextprotocol/server @modelcontextprotocol/express express

# For MCP Streamable HTTP over Node.js (IncomingMessage/ServerResponse):
npm install @modelcontextprotocol/node
```

## Exports

- `createMcpExpressApp(options?)`
- `hostHeaderValidation(allowedHostnames)`
- `localhostHostValidation()`
- `requireBearerAuth(options)`
- `mcpAuthMetadataRouter(options)`
- `getOAuthProtectedResourceMetadataUrl(serverUrl)`
- `OAuthTokenVerifier` (interface)

## Usage

### Create an Express app (localhost DNS rebinding protection by default)

```ts
import { createMcpExpressApp } from '@modelcontextprotocol/express';

const app = createMcpExpressApp(); // default host is 127.0.0.1; protection enabled
```

### Streamable HTTP endpoint (Express)

```ts
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer } from '@modelcontextprotocol/server';

const app = createMcpExpressApp();
const server = new McpServer({ name: 'my-server', version: '1.0.0' });

app.post('/mcp', async (req, res) => {
    // Stateless example: create a transport per request.
    // For stateful mode (sessions), keep a transport instance around and reuse it.
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
});
```

### Host header validation (DNS rebinding protection)

```ts
import { hostHeaderValidation } from '@modelcontextprotocol/express';

app.use(hostHeaderValidation(['localhost', '127.0.0.1', '[::1]']));
```
