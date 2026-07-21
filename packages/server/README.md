# `@modelcontextprotocol/server`

The MCP (Model Context Protocol) TypeScript server SDK. Build MCP servers that expose tools, resources, and prompts.

<!-- prettier-ignore -->
> [!WARNING]
> **This is a beta release.** The API surface is settling but breaking changes remain possible until v2 stabilizes. Please try it and open issues — feedback during the beta directly shapes the stable release.

<!-- prettier-ignore -->
> [!NOTE]
> This is **v2** of the MCP TypeScript SDK. It replaces the monolithic `@modelcontextprotocol/sdk` package from v1. See the **[migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md)** if you're coming from v1.

## Install

```bash
npm install @modelcontextprotocol/server@beta
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
