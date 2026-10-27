---
shape: explanation
---

# Packages and subpath exports

The SDK is published as nine npm packages. Most projects install exactly one of them.

## Start from one package

Everything in [Build your first server](./first-server.md) came from a single install, `@modelcontextprotocol/server` — through two import paths.

```ts source="../../examples/guides/get-started/packages.examples.ts#packages_serverEntryPoints"
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
```

The first path is the package's root entry. The second is a **subpath export** — a separate entry point inside the same package, declared in its `exports` map.

## Pick the package for your side of the protocol

Install the package for the side of the protocol you are building.

```sh
npm install @modelcontextprotocol/server   # expose tools, resources, prompts
npm install @modelcontextprotocol/client   # connect to servers and call them
```

Those two are the starting point for almost everything; a process that plays both roles installs both. The full published set is nine packages:

- `@modelcontextprotocol/server` and `@modelcontextprotocol/client` — the two starting points, one per side.
- `@modelcontextprotocol/node`, `@modelcontextprotocol/express`, `@modelcontextprotocol/hono`, `@modelcontextprotocol/fastify` — optional adapters for serving over HTTP.
- `@modelcontextprotocol/core` — the raw Zod wire schemas.
- `@modelcontextprotocol/server-legacy` and `@modelcontextprotocol/codemod` — migration surfaces for v1 code.

A tenth package in the repository, `@modelcontextprotocol/core-internal`, is private: `server` and `client` bundle it at build time, so it never appears in your dependency tree.

## Keep Node-only code behind the `./stdio` subpath

`StdioClientTransport` spawns the server as a child process, so it is exported from `./stdio`, never from the root entry.

```ts source="../../examples/guides/get-started/packages.examples.ts#packages_clientStdioSubpath"
// Runs anywhere: browsers, Workers, Node.
import { Client } from '@modelcontextprotocol/client';
// Spawns a child process — Node-only, so it lives behind the subpath.
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
```

The root entry of every package is **runtime-neutral**: its module graph never reaches `node:child_process` or any other Node builtin a browser or Cloudflare Workers bundler cannot resolve. Importing `./stdio` is the explicit opt-in to a process runtime. `@modelcontextprotocol/server/stdio` is the server-side counterpart and exports `serveStdio` and `StdioServerTransport`.

::: info Coming from v1?
v1's single `@modelcontextprotocol/sdk` package exposed deep file paths such as `@modelcontextprotocol/sdk/server/mcp.js`. The v2 packages declare an `exports` map, so only the subpaths each package names resolve — the codemod rewrites the imports for you.
:::

## Add a framework adapter when you serve over HTTP

`createMcpHandler` from `@modelcontextprotocol/server` already serves MCP over web-standard `Request` and `Response` objects. An adapter package wires that handler into a specific runtime or framework; install the adapter next to the framework it adapts.

```sh
npm install @modelcontextprotocol/express express
```

Four adapters exist: `@modelcontextprotocol/node` for Node's built-in `http` server, and one each for Express, Hono, and Fastify. They are thin layers over `createMcpHandler` and add no MCP behavior of their own.

[Serve over HTTP](../serving/http.md) covers the handler itself; [Express](../serving/express.md), [Hono](../serving/hono.md), and [Fastify](../serving/fastify.md) each have a recipe.

## Reach for `core` only to validate raw wire JSON

`@modelcontextprotocol/core` exports the Zod schema constants the SDK validates protocol payloads against, for code that handles raw JSON-RPC payloads itself — gateways, proxies, log pipelines. Neither `server` nor `client` exports a Zod schema, and the matching TypeScript types ship with both, so if you only call `registerTool` and `callTool` you never import it directly — it arrives transitively, since `server` and `client` resolve their shared schema graph from it at runtime. [Wire schemas](../advanced/wire-schemas.md) is the how-to.

## Leave `server-legacy` and `codemod` to the migration guide

`@modelcontextprotocol/server-legacy` is a frozen copy of v1's server-side SSE transport and OAuth Authorization Server helpers, published so a v1 deployment can move to v2 without replacing everything at once. `@modelcontextprotocol/codemod` is the command-line tool that rewrites v1 imports and call sites to their v2 forms. Neither belongs in a new project — the [upgrade guide](../migration/upgrade-to-v2.md) covers both.

## Recap

- `@modelcontextprotocol/server` and `@modelcontextprotocol/client` are the two packages you install, one per side of the protocol.
- Package root entries are runtime-neutral; code that spawns processes lives at the `./stdio` subpath and only enters your bundle when you import it.
- The HTTP adapters — `node`, `express`, `hono`, `fastify` — are optional thin layers over `createMcpHandler`; install at most one.
- `@modelcontextprotocol/core` exports only Zod schema constants, for code that validates raw wire JSON itself.
- `@modelcontextprotocol/server-legacy` and `@modelcontextprotocol/codemod` exist for migration from v1, not for new projects.
