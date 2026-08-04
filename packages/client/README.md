# `@modelcontextprotocol/client`

The MCP (Model Context Protocol) TypeScript client SDK. Build MCP clients that connect to MCP servers.

<!-- prettier-ignore -->
> [!WARNING]
> **v2 is the stable release line**, implementing the [2026-07-28 MCP spec](https://modelcontextprotocol.io/specification/2026-07-28). Migrating from v1? Start with the [migration guide](https://ts.sdk.modelcontextprotocol.io/v2/migration/).

<!-- prettier-ignore -->
> [!NOTE]
> This is **v2** of the MCP TypeScript SDK. It replaces the monolithic `@modelcontextprotocol/sdk` package from v1. See the **[migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md)** if you're coming from v1.

## Install

```bash
npm install @modelcontextprotocol/client
```

TypeScript ≥6.0 no longer auto-includes `@types/*` — add `"types": ["node"]` to your `tsconfig.json` `compilerOptions` (the published `.d.mts` references `Buffer`).

## Documentation

- **[Repository README](https://github.com/modelcontextprotocol/typescript-sdk#readme)** — overview, package layout, examples
- **[Client guide](https://ts.sdk.modelcontextprotocol.io/v2/clients/connect)** — connecting, calling tools, OAuth, and middleware
- **[API reference](https://ts.sdk.modelcontextprotocol.io/v2/)**
- **[MCP specification](https://modelcontextprotocol.io)**
