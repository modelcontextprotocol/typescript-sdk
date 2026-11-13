# `@modelcontextprotocol/server`

The MCP (Model Context Protocol) TypeScript server SDK. Build MCP servers that expose tools, resources, and prompts.

> **This is v2 of the MCP TypeScript SDK, the stable release line**, implementing the [2026-07-28 MCP spec](https://modelcontextprotocol.io/specification/2026-07-28). It replaces the single `@modelcontextprotocol/sdk` package from v1. Start with the [documentation](https://ts.sdk.modelcontextprotocol.io/v2/); coming from v1, see the [migration guide](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2). Found a problem? [Open an issue](https://github.com/modelcontextprotocol/typescript-sdk/issues/new?template=v2-feedback.yml).

## Install

```bash
npm install @modelcontextprotocol/server
```

TypeScript ≥6.0 no longer auto-includes `@types/*` — add `"types": ["node"]` to your `tsconfig.json` `compilerOptions` (the published `.d.mts` references `Buffer`).

Optional framework adapters: [`@modelcontextprotocol/express`](https://www.npmjs.com/package/@modelcontextprotocol/express), [`@modelcontextprotocol/fastify`](https://www.npmjs.com/package/@modelcontextprotocol/fastify), [`@modelcontextprotocol/hono`](https://www.npmjs.com/package/@modelcontextprotocol/hono),
[`@modelcontextprotocol/node`](https://www.npmjs.com/package/@modelcontextprotocol/node).

## Documentation

- **[Repository README](https://github.com/modelcontextprotocol/typescript-sdk#readme)** — overview, package layout, examples
- **[Server guide](https://ts.sdk.modelcontextprotocol.io/v2/servers/tools)** — tools, resources, prompts, and the rest of the server surface
- **[Serving guide](https://ts.sdk.modelcontextprotocol.io/v2/serving/http)** — stdio, HTTP, the framework adapters, sessions, and authorization
- **[API reference](https://ts.sdk.modelcontextprotocol.io/v2/)**
- **[MCP specification](https://modelcontextprotocol.io)**
