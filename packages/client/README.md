# `@modelcontextprotocol/client`

The MCP (Model Context Protocol) TypeScript client SDK. Build MCP clients that connect to MCP servers.

<!-- prettier-ignore -->
> [!WARNING]
> **This is a beta release.** The API surface is settling but breaking changes remain possible until v2 stabilizes. Please try it and open issues — feedback during the beta directly shapes the stable release.

<!-- prettier-ignore -->
> [!NOTE]
> This is **v2** of the MCP TypeScript SDK. It replaces the monolithic `@modelcontextprotocol/sdk` package from v1. See the **[migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md)** if you're coming from v1.

## Install

```bash
npm install @modelcontextprotocol/client@beta
```

TypeScript ≥6.0 no longer auto-includes `@types/*` — add `"types": ["node"]` to your `tsconfig.json` `compilerOptions` (the published `.d.mts` references `Buffer`).

## Documentation

- **[Repository README](https://github.com/modelcontextprotocol/typescript-sdk#readme)** — overview, package layout, examples
- **[Client guide](https://ts.sdk.modelcontextprotocol.io/v2/clients/connect)** — connecting, calling tools, OAuth, and middleware
- **[API reference](https://ts.sdk.modelcontextprotocol.io/v2/)**
- **[MCP specification](https://modelcontextprotocol.io)**
