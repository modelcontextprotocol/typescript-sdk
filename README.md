# MCP TypeScript SDK

<!-- prettier-ignore -->
> [!IMPORTANT]
> **This is the `main` branch — v2 of the SDK, now in beta** (`@modelcontextprotocol/server`, `@modelcontextprotocol/client`), implementing the [2026-07-28 MCP spec](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/).
>
> **Have feedback? Please [open a v2 issue](https://github.com/modelcontextprotocol/typescript-sdk/issues/new?template=v2-feedback.yml)** — it is the most useful thing you can do for the SDK right now. The [v2 documentation](https://ts.sdk.modelcontextprotocol.io/v2/) starts with a ten-minute server tutorial.
>
> We expect a stable release alongside the full release of the 2026-07-28 spec on July 28, 2026. Until then, **v1.x remains the supported release for production**; it keeps receiving bug fixes and security updates for at least 6 months after v2 ships. v1 documentation: [ts.sdk.modelcontextprotocol.io](https://ts.sdk.modelcontextprotocol.io/) · v2: [`/v2/`](https://ts.sdk.modelcontextprotocol.io/v2/).

<!-- prettier-ignore -->
> [!WARNING]
> **We're limiting pull requests to 1 per new contributor while we land the [2026-07-28 spec](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/) implementation.**
>
> [Issues](https://github.com/modelcontextprotocol/typescript-sdk/issues/new?template=v2-feedback.yml) are the most useful feedback right now — we'll reopen PRs as v2 stabilizes.

[![NPM Version - Server](https://img.shields.io/npm/v/%40modelcontextprotocol%2Fserver?label=%40modelcontextprotocol%2Fserver)](https://www.npmjs.com/package/@modelcontextprotocol/server)
[![NPM Version - Client](https://img.shields.io/npm/v/%40modelcontextprotocol%2Fclient?label=%40modelcontextprotocol%2Fclient)](https://www.npmjs.com/package/@modelcontextprotocol/client) ![MIT licensed](https://img.shields.io/npm/l/%40modelcontextprotocol%2Fserver)

<details>
<summary>Table of Contents</summary>

- [Overview](#overview)
- [Packages](#packages)
- [Installation](#installation)
- [Getting Started](#getting-started)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

</details>

## Overview

The Model Context Protocol (MCP) allows applications to provide context for LLMs in a standardized way, separating the concerns of providing context from the actual LLM interaction.

This repository contains the TypeScript SDK implementation of the MCP specification. It runs on **Node.js**, **Bun**, and **Deno**, and ships:

- MCP **server** libraries (tools/resources/prompts, Streamable HTTP, stdio, auth helpers)
- MCP **client** libraries (transports, high-level helpers, OAuth helpers)
- Optional **middleware packages** for specific runtimes/frameworks (Express, Hono, Fastify, Node.js HTTP)
- Runnable **examples** (under [`examples/`](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/examples))

## Packages

This monorepo publishes split packages:

- **`@modelcontextprotocol/server`**: build MCP servers
- **`@modelcontextprotocol/client`**: build MCP clients

Tool and prompt schemas use [Standard Schema](https://standardschema.dev/) — bring Zod v4, Valibot, ArkType, or any compatible library.

### Middleware packages (optional)

The SDK also publishes small "middleware" packages under [`packages/middleware/`](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/packages/middleware) that help you **wire MCP into a specific runtime or web framework**.

They are intentionally thin adapters: they should not introduce new MCP functionality or business logic. See [`packages/middleware/README.md`](packages/middleware/README.md) for details.

- **`@modelcontextprotocol/node`**: Node.js Streamable HTTP transport wrapper for `IncomingMessage` / `ServerResponse`
- **`@modelcontextprotocol/express`**: Express helpers (app defaults + Host header validation)
- **`@modelcontextprotocol/hono`**: Hono helpers (app defaults + JSON body parsing hook + Host header validation)
- **`@modelcontextprotocol/fastify`**: Fastify helpers (app defaults + Host header validation)

## Installation

### Server

```bash
npm install @modelcontextprotocol/server
# or
bun add @modelcontextprotocol/server
# or
deno add npm:@modelcontextprotocol/server
```

### Client

```bash
npm install @modelcontextprotocol/client
# or
bun add @modelcontextprotocol/client
# or
deno add npm:@modelcontextprotocol/client
```

### Optional middleware packages

The SDK also publishes optional “middleware” packages that help you **wire MCP into a specific runtime or web framework** (for example Express, Hono, or Node.js `http`).

These packages are intentionally thin adapters and should not introduce additional MCP features or business logic. See [`packages/middleware/README.md`](packages/middleware/README.md) for details.

```bash
# Node.js HTTP (IncomingMessage/ServerResponse) Streamable HTTP transport:
npm install @modelcontextprotocol/node

# Express integration:
npm install @modelcontextprotocol/express express

# Hono integration:
npm install @modelcontextprotocol/hono hono

# Fastify integration:
npm install @modelcontextprotocol/fastify fastify
```

## Getting Started

Here is what an MCP server looks like. This minimal example exposes a single `greet` tool over stdio:

```typescript
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

const server = new McpServer({ name: 'greeting-server', version: '1.0.0' });

server.registerTool(
    'greet',
    {
        description: 'Greet someone by name',
        inputSchema: z.object({ name: z.string() })
    },
    async ({ name }) => ({
        content: [{ type: 'text', text: `Hello, ${name}!` }]
    })
);

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main();
```

Ready to build something real? Follow the step-by-step tutorials:

- [Build your first server](docs/get-started/first-server.md) — a stdio weather-alert server, from `npm init` to a tool call
- [Build your first client](docs/get-started/first-client.md) — connect to that server, list its tools, and call them

For runnable, end-to-end examples beyond the tutorials, see:

- [`examples/README.md`](examples/README.md) — runnable, self-verifying client/server example pairs (one story per directory)

## Documentation

- [Build a server](docs/get-started/first-server.md) — your first MCP server, step by step
- [Build a client](docs/get-started/first-client.md) — your first MCP client, step by step
- [Documentation site](https://ts.sdk.modelcontextprotocol.io/v2/) — the full guides: tools, resources, prompts, serving over HTTP and stdio, clients, OAuth, and migration
- [Troubleshooting](docs/troubleshooting.md) — common errors and their fixes
- [API reference](https://ts.sdk.modelcontextprotocol.io/v2/api/)
- [MCP documentation](https://modelcontextprotocol.io/docs)
- [MCP specification](https://modelcontextprotocol.io/specification/latest)

### Building docs locally

To work on the documentation site locally:

```bash
pnpm docs:api      # Generate the API reference markdown (output: docs/api/)
pnpm docs:dev      # Start the VitePress dev server for the V2 site
pnpm docs:build    # Build the V2 site (output: docs/.vitepress/dist/)
pnpm docs:multi    # Build the combined V1 + V2 site (output: tmp/docs-combined/)
```

The `docs:multi` script builds the V2 site from the current checkout, checks out the `v1.x` branch via a git worktree to build the V1 site, and produces a combined site with V1 docs at the root and V2 docs under `/v2/`.

## v1 (legacy) documentation and fixes

If you are using the **v1** generation of the SDK, the **v1 API documentation** is available at [`https://ts.sdk.modelcontextprotocol.io/`](https://ts.sdk.modelcontextprotocol.io/). The v1 source code and any v1-specific fixes live on the long-lived
[`v1.x` branch](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x). V2 API docs are at [`/v2/`](https://ts.sdk.modelcontextprotocol.io/v2/).

## Contributing

Issues and pull requests are welcome on GitHub at <https://github.com/modelcontextprotocol/typescript-sdk>.

## License

This project is licensed under the Apache License 2.0 for new contributions, with existing code under MIT. See the [LICENSE](LICENSE) file for details.
