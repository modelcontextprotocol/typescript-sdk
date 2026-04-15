# @modelcontextprotocol/sdk

The **primary entry point** for the Model Context Protocol TypeScript SDK.

This meta-package re-exports the full public surface of [`@modelcontextprotocol/server`](../server), [`@modelcontextprotocol/client`](../client), and [`@modelcontextprotocol/node`](../middleware/node), so most applications can depend on this package alone:

```ts
import { McpServer, Client, NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk';
```

## Upgrading from v1

`@modelcontextprotocol/sdk` v2 is a drop-in upgrade for most v1 servers — just bump the version. v1 deep-import paths (`@modelcontextprotocol/sdk/types.js`, `/server/mcp.js`, `/client/index.js`, `/shared/transport.js`, etc.) are preserved as compatibility subpaths that re-export
the matching v2 symbols and emit one-time deprecation warnings where the API shape changed.

See [`docs/migration.md`](../../docs/migration.md) for the full mapping.

## When to use the sub-packages directly

Bundle-sensitive targets (browsers, Cloudflare Workers) should import from `@modelcontextprotocol/client` or `@modelcontextprotocol/server` directly to avoid pulling in Node-only transports.
