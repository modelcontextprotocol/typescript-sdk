---
shape: landing
---

# MCP TypeScript SDK

::: info v2 beta
This is the documentation for **v2** of the SDK, currently in **beta**: the API is settling but can still change before the stable release alongside the [2026-07-28 spec](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/). [Tell us what you find](https://github.com/modelcontextprotocol/typescript-sdk/issues/new?template=v2-feedback.yml) — and if you need the stable v1, its documentation is at [ts.sdk.modelcontextprotocol.io](https://ts.sdk.modelcontextprotocol.io/).
:::

The **Model Context Protocol** (MCP) is an open standard that connects AI applications to the systems where your data and tools live. You write a **server** that exposes tools, resources, and prompts; any MCP **host** — Claude Code, VS Code, Cursor, your own application — connects to it and lets a model use them. The protocol is defined by [the MCP specification](https://modelcontextprotocol.io/specification/latest); this SDK is its TypeScript implementation, on Node.js, Bun, and Deno.

A complete server is one file:

```ts source="../examples/guides/index.examples.ts#serveStdio_minimal"
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

serveStdio(() => {
    const server = new McpServer({ name: 'weather', version: '1.0.0' });

    server.registerTool(
        'get-forecast',
        {
            description: 'Get the weather forecast for a city',
            inputSchema: z.object({ city: z.string() })
        },
        async ({ city }) => ({
            content: [{ type: 'text', text: `Sunny in ${city} all week.` }]
        })
    );

    return server;
});
```

Any MCP host that launches this program lists and calls `get-forecast`; the SDK validates every call against that `z.object(...)` schema before your handler runs. [Build a server](./get-started/first-server.md) installs the packages and runs it end to end.

## Pick a path

- Expose your API or data to AI applications → **[Build a server](./get-started/first-server.md)**
- Build an application that talks to MCP servers → **[Build a client](./get-started/first-client.md)**
- Coming from v1 (`@modelcontextprotocol/sdk`) → **[Upgrade](./migration/index.md)**
- Drop MCP into the app you already run → **[Express](./serving/express.md)** · **[Hono](./serving/hono.md)** · **[Fastify](./serving/fastify.md)** · **[Workers](./serving/web-standard.md)**

For exact signatures, go to the [API reference](/api/).

## Recap

- MCP connects AI applications to the systems where your tools and data live; you build one side, a host brings the model.
- `registerTool(name, config, handler)` with a `z.object(...)` `inputSchema` defines a tool; `serveStdio` serves it over stdio.
- Four starting points: build a server, build a client, upgrade from v1, or drop into Express, Hono, Fastify, or Workers.
