# `@modelcontextprotocol/client`

The MCP (Model Context Protocol) TypeScript client SDK. Build MCP clients that connect to MCP servers.

> **This is v2 of the MCP TypeScript SDK, the stable release line**, implementing the [2026-07-28 MCP spec](https://modelcontextprotocol.io/specification/2026-07-28). It replaces the single `@modelcontextprotocol/sdk` package from v1. Start with the [documentation](https://ts.sdk.modelcontextprotocol.io/v2/); coming from v1, see the [migration guide](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2). Found a problem? [Open an issue](https://github.com/modelcontextprotocol/typescript-sdk/issues/new?template=v2-feedback.yml).

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
