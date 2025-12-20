# `@modelcontextprotocol/server-express`

Express adapters for the MCP TypeScript server SDK.

This package is the Express-specific companion to [`@modelcontextprotocol/server`](../server/), which is framework-agnostic and uses Web Standard `Request`/`Response` interfaces.

## Install

```bash
npm install @modelcontextprotocol/server @modelcontextprotocol/server-express zod
```

## Exports

- `createMcpExpressApp(options?)`
- `hostHeaderValidation(allowedHosts)`
- `localhostHostValidation()`
- `mcpAuthRouter(options)`
- `mcpAuthMetadataRouter(options)`
- `requireBearerAuth(options)`

## Usage

### Create an Express app with localhost DNS rebinding protection

```ts
import { createMcpExpressApp } from '@modelcontextprotocol/server-express';

const app = createMcpExpressApp(); // default host is 127.0.0.1; protection enabled
```

### Streamable HTTP endpoint (Express)

```ts
import { McpServer, StreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { createMcpExpressApp } from '@modelcontextprotocol/server-express';

const app = createMcpExpressApp();

app.post('/mcp', async (req, res) => {
    const transport = new StreamableHTTPServerTransport();
    await transport.handleRequest(req, res, req.body);
});
```

### OAuth routes (Express)

`@modelcontextprotocol/server` provides Web-standard auth handlers; this package wraps them as Express routers.

```ts
import { mcpAuthRouter } from '@modelcontextprotocol/server-express';
import type { OAuthServerProvider } from '@modelcontextprotocol/server';
import express from 'express';

const provider: OAuthServerProvider = /* ... */;
const app = express();
app.use(express.json());

// MUST be mounted at the app root
app.use(
  mcpAuthRouter({
    provider,
    issuerUrl: new URL('https://auth.example.com'),
    // Optional rate limiting (implemented via express-rate-limit)
    rateLimit: { windowMs: 60_000, max: 60 }
  })
);
```

### Bearer auth middleware (Express)

`requireBearerAuth` validates the `Authorization: Bearer ...` header and sets `req.auth` on success.

```ts
import { requireBearerAuth } from '@modelcontextprotocol/server-express';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/server';

const verifier: OAuthTokenVerifier = /* ... */;

app.post('/protected', requireBearerAuth({ verifier }), (req, res) => {
  res.json({ clientId: req.auth?.clientId });
});
```
