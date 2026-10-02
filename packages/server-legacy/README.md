# @modelcontextprotocol/server-legacy

> **Deprecated** — This package is a frozen copy of v1 code for migration purposes only. It will not receive new features and is planned for removal in v3.

Provides two pieces of v1 server functionality removed in v2:

- **SSE Transport** (`./sse`) — The `SSEServerTransport` class, replaced in v2 by `NodeStreamableHTTPServerTransport` (from `@modelcontextprotocol/node`) or `WebStandardStreamableHTTPServerTransport` (from `@modelcontextprotocol/server`)
- **OAuth Authorization Server** (`./auth`) — The `mcpAuthRouter` and related helpers, removed in v2 because MCP servers should use dedicated OAuth providers

## Installation

```bash
npm install @modelcontextprotocol/server-legacy
```

## Usage

### SSE Transport (no Express dependency required)

```ts
import { SSEServerTransport } from '@modelcontextprotocol/server-legacy/sse';
```

### OAuth Auth Router (requires Express)

```ts
import { mcpAuthRouter } from '@modelcontextprotocol/server-legacy/auth';
```

### Everything (requires Express)

```ts
import { SSEServerTransport, mcpAuthRouter } from '@modelcontextprotocol/server-legacy';
```

## Migration

- **SSE → StreamableHTTP**: Use `NodeStreamableHTTPServerTransport` from `@modelcontextprotocol/node` (Node.js) or `WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/server` (Web Standard / Cloudflare Workers)
- **Auth router → Dedicated IdP**: Use a dedicated OAuth provider (Auth0, Keycloak, etc.) instead of the built-in OAuth Authorization Server
