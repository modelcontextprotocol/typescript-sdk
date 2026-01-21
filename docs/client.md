---
title: Client
---

## Client overview

The SDK provides a high-level `Client` class that connects to MCP servers over different transports:

- `StdioClientTransport` – for local processes you spawn.
- `StreamableHTTPClientTransport` – for remote HTTP servers.
- `SSEClientTransport` – for legacy HTTP+SSE servers (deprecated).

Runnable client examples live under:

- [`simpleStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/simpleStreamableHttp.ts)
- [`streamableHttpWithSseFallbackClient.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/streamableHttpWithSseFallbackClient.ts)
- [`ssePollingClient.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/ssePollingClient.ts)
- [`multipleClientsParallel.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/multipleClientsParallel.ts)
- [`parallelToolCallsClient.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/parallelToolCallsClient.ts)

## Connecting and basic operations

A typical flow:

1. Construct a `Client` with name, version and capabilities.
2. Create a transport and call `client.connect(transport)`.
3. Use high-level helpers:
    - `listTools`, `callTool`
    - `listPrompts`, `getPrompt`
    - `listResources`, `readResource`

See [`simpleStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/simpleStreamableHttp.ts) for an interactive CLI client that exercises these methods and shows how to handle notifications, elicitation and tasks.

## Transports and backwards compatibility

To support both modern Streamable HTTP and legacy SSE servers, use a client that:

1. Tries `StreamableHTTPClientTransport`.
2. Falls back to `SSEClientTransport` on a 4xx response.

Runnable example:

- [`streamableHttpWithSseFallbackClient.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/streamableHttpWithSseFallbackClient.ts)

## OAuth client authentication helpers

For OAuth-secured MCP servers, the client `auth` module exposes:

- `ClientCredentialsProvider`
- `PrivateKeyJwtProvider`
- `StaticPrivateKeyJwtProvider`

Examples:

- [`simpleOAuthClient.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/simpleOAuthClient.ts)
- [`simpleOAuthClientProvider.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/simpleOAuthClientProvider.ts)
- [`simpleClientCredentials.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/simpleClientCredentials.ts)
- Server-side auth demo: [`demoInMemoryOAuthProvider.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/shared/src/demoInMemoryOAuthProvider.ts) (tests live under `examples/shared/test/demoInMemoryOAuthProvider.test.ts`)

These examples show how to:

- Perform dynamic client registration if needed.
- Acquire access tokens.
- Attach OAuth credentials to Streamable HTTP requests.

#### Cross-App Access Middleware

The `withCrossAppAccess` middleware enables secure authentication for MCP clients accessing protected servers through OAuth-based Cross-App Access flows. It automatically handles token acquisition and adds Authorization headers to requests.

```typescript
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { withCrossAppAccess } from '@modelcontextprotocol/client';

// Configure Cross-App Access middleware
const enhancedFetch = withCrossAppAccess({
    idpUrl: 'https://idp.example.com',
    mcpResourceUrl: 'https://mcp-server.example.com',
    mcpAuthorisationServerUrl: 'https://mcp-auth.example.com',
    idToken: 'your-id-token',
    idpClientId: 'your-idp-client-id',
    idpClientSecret: 'your-idp-client-secret',
    mcpClientId: 'your-mcp-client-id',
    mcpClientSecret: 'your-mcp-client-secret',
    scope: ['read', 'write'] // Optional scopes
})(fetch);

// Use the enhanced fetch with your client transport
const transport = new StreamableHTTPClientTransport(
    new URL('https://mcp-server.example.com/mcp'),
    enhancedFetch
);

const client = new Client({
    name: 'secure-client',
    version: '1.0.0'
});

await client.connect(transport);
```

The middleware performs a two-step OAuth flow:

1. Exchanges your ID token for an authorization grant from the IdP
2. Exchanges the grant for an access token from the MCP authorization server
3. Automatically adds the access token to all subsequent requests

**Configuration Options:**

- **`idpUrl`**: Identity Provider's base URL for OAuth discovery
- **`idToken`**: Identity token obtained from user authentication with the IdP
- **`idpClientId`** / **`idpClientSecret`**: Credentials for authentication with the IdP
- **`mcpResourceUrl`**: MCP resource server URL (used in token exchange request)
- **`mcpAuthorisationServerUrl`**: MCP authorization server URL for OAuth discovery
- **`mcpClientId`** / **`mcpClientSecret`**: Credentials for authentication with the MCP server
- **`scope`**: Optional array of scope strings (e.g., `['read', 'write']`)

**Token Caching:**

The middleware caches the access token after the first successful exchange, so the token exchange flow only happens once. Subsequent requests reuse the cached token without additional OAuth calls.
