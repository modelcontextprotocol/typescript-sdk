# @modelcontextprotocol/server-auth-legacy

<!-- prettier-ignore -->
> [!WARNING]
> **Deprecated.** This package is a frozen copy of the v1 SDK's `src/server/auth/` Authorization Server helpers (`mcpAuthRouter`, `ProxyOAuthServerProvider`, etc.). It exists solely to ease migration from `@modelcontextprotocol/sdk` v1 and will not receive new features or non-critical bug fixes.

The v2 SDK no longer ships an OAuth Authorization Server implementation. MCP servers are Resource Servers; running your own AS is an anti-pattern for most deployments.

## Migration

- **Resource Server glue** (`requireBearerAuth`, `mcpAuthMetadataRouter`, Protected Resource Metadata): use the first-class helpers in `@modelcontextprotocol/express`.
- **Authorization Server**: use a dedicated IdP (Auth0, Keycloak, Okta, etc.) or a purpose-built OAuth library.

## Usage (legacy)

```ts
import express from 'express';
import { mcpAuthRouter, ProxyOAuthServerProvider } from '@modelcontextprotocol/server-auth-legacy';

const app = express();
app.use(mcpAuthRouter({ provider, issuerUrl: new URL('https://example.com') }));
```
