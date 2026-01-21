---
title: Server
---

## Server overview

This SDK lets you build MCP servers in TypeScript and connect them to different transports. For most use cases you will use `McpServer` from `@modelcontextprotocol/server` and choose one of:

- **Streamable HTTP** (recommended for remote servers)
- **HTTP + SSE** (deprecated, for backwards compatibility only)
- **stdio** (for local, process‑spawned integrations)

For a complete, runnable example server, see:

- [`simpleStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/simpleStreamableHttp.ts) – feature‑rich Streamable HTTP server
- [`jsonResponseStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/jsonResponseStreamableHttp.ts) – Streamable HTTP with JSON response mode
- [`simpleStatelessStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/simpleStatelessStreamableHttp.ts) – stateless Streamable HTTP server
- [`simpleSseServer.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/simpleSseServer.ts) – deprecated HTTP+SSE transport
- [`sseAndStreamableHttpCompatibleServer.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/sseAndStreamableHttpCompatibleServer.ts) – backwards‑compatible server for old and new clients

## Transports

### Streamable HTTP

Streamable HTTP is the modern, fully featured transport. It supports:

- Request/response over HTTP POST
- Server‑to‑client notifications over SSE (when enabled)
- Optional JSON‑only response mode with no SSE
- Session management and resumability

Key examples:

- [`simpleStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/simpleStreamableHttp.ts) – sessions, logging, tasks, elicitation, auth hooks
- [`jsonResponseStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/jsonResponseStreamableHttp.ts) – `enableJsonResponse: true`, no SSE
- [`standaloneSseWithGetStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/standaloneSseWithGetStreamableHttp.ts) – notifications with Streamable HTTP GET + SSE

See the MCP spec for full transport details: `https://modelcontextprotocol.io/specification/2025-11-25/basic/transports`

### Stateless vs stateful sessions

Streamable HTTP can run:

- **Stateless** – no session tracking, ideal for simple API‑style servers.
- **Stateful** – sessions have IDs, and you can enable resumability and advanced features.

Examples:

- Stateless Streamable HTTP: [`simpleStatelessStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/simpleStatelessStreamableHttp.ts)
- Stateful with resumability: [`simpleStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/simpleStreamableHttp.ts)

### Deprecated HTTP + SSE

The older HTTP+SSE transport (protocol version 2024‑11‑05) is supported only for backwards compatibility. New implementations should prefer Streamable HTTP.

Examples:

- Legacy SSE server: [`simpleSseServer.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/simpleSseServer.ts)
- Backwards‑compatible server (Streamable HTTP + SSE):  
  [`sseAndStreamableHttpCompatibleServer.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/sseAndStreamableHttpCompatibleServer.ts)

## Running your server

For a minimal “getting started” experience:

1. Start from [`simpleStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/simpleStreamableHttp.ts).
2. Remove features you do not need (tasks, advanced logging, OAuth, etc.).
3. Register your own tools, resources and prompts.

For more detailed patterns (stateless vs stateful, JSON response mode, CORS, DNS rebind protection), see the examples above and the MCP spec sections on transports.

## DNS rebinding protection

MCP servers running on localhost are vulnerable to DNS rebinding attacks. Use `createMcpExpressApp()` to create an Express app with DNS rebinding protection enabled by default:

```typescript
import { createMcpExpressApp } from '@modelcontextprotocol/express';

// Protection auto-enabled (default host is 127.0.0.1)
const app = createMcpExpressApp();

// Protection auto-enabled for localhost
const app = createMcpExpressApp({ host: 'localhost' });

// No auto protection when binding to all interfaces, unless you provide allowedHosts
const app = createMcpExpressApp({ host: '0.0.0.0' });
```

When binding to `0.0.0.0` / `::`, provide an allow-list of hosts:

```typescript
import { createMcpExpressApp } from '@modelcontextprotocol/express';

const app = createMcpExpressApp({
    host: '0.0.0.0',
    allowedHosts: ['localhost', '127.0.0.1', 'myhost.local']
});
```

## Tools, resources, and prompts

### Tools

Tools let MCP clients ask your server to take actions. They are usually the main way that LLMs call into your application.

A typical registration with `registerTool` looks like this:

```typescript
server.registerTool(
    'calculate-bmi',
    {
        title: 'BMI Calculator',
        description: 'Calculate Body Mass Index',
        inputSchema: {
            weightKg: z.number(),
            heightM: z.number()
        },
        outputSchema: { bmi: z.number() }
    },
    async ({ weightKg, heightM }) => {
        const output = { bmi: weightKg / (heightM * heightM) };
        return {
            content: [{ type: 'text', text: JSON.stringify(output) }],
            structuredContent: output
        };
    }
);
```

This snippet is illustrative only; for runnable servers that expose tools, see:

- [`simpleStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/simpleStreamableHttp.ts)
- [`toolWithSampleServer.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/toolWithSampleServer.ts)

#### ResourceLink outputs

Tools can return `resource_link` content items to reference large resources without embedding them directly, allowing clients to fetch only what they need.

The README’s `list-files` example shows the pattern conceptually; for concrete usage, see the Streamable HTTP examples in `examples/server/src`.

### Resources

Resources expose data to clients, but should not perform heavy computation or side‑effects. They are ideal for configuration, documents, or other reference data.

Conceptually, you might register resources like:

```typescript
server.registerResource(
    'config',
    'config://app',
    {
        title: 'Application Config',
        description: 'Application configuration data',
        mimeType: 'text/plain'
    },
    async uri => ({
        contents: [{ uri: uri.href, text: 'App configuration here' }]
    })
);
```

Dynamic resources use `ResourceTemplate` and can support completions on path parameters. For full runnable examples of resources:

- [`simpleStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/simpleStreamableHttp.ts)

### Prompts

Prompts are reusable templates that help humans (or client UIs) talk to models in a consistent way. They are declared on the server and listed through MCP.

A minimal prompt:

```typescript
server.registerPrompt(
    'review-code',
    {
        title: 'Code Review',
        description: 'Review code for best practices and potential issues',
        argsSchema: { code: z.string() }
    },
    ({ code }) => ({
        messages: [
            {
                role: 'user',
                content: {
                    type: 'text',
                    text: `Please review this code:\n\n${code}`
                }
            }
        ]
    })
);
```

For prompts integrated into a full server, see:

- [`simpleStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/simpleStreamableHttp.ts)

### Completions

Both prompts and resources can support argument completions. On the client side, you use `client.complete()` with a reference to the prompt or resource and the partially‑typed argument.

See the MCP spec sections on prompts and resources for complete details, and [`simpleStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/simpleStreamableHttp.ts) for client‑side usage patterns.

### Display names and metadata

Tools, resources and prompts support a `title` field for human‑readable names. Older APIs can also attach `annotations.title`. To compute the correct display name on the client, use:

- `getDisplayName` from `@modelcontextprotocol/client`

## Multi‑node deployment patterns

The SDK supports multi‑node deployments using Streamable HTTP. The high‑level patterns and diagrams live with the runnable server examples:

- [`examples/server/README.md`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/README.md#multi-node-deployment-patterns)

## Backwards compatibility

To handle both modern and legacy clients:

- Run a backwards‑compatible server:
    - [`sseAndStreamableHttpCompatibleServer.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/sseAndStreamableHttpCompatibleServer.ts)
- Use a client that falls back from Streamable HTTP to SSE:
    - [`streamableHttpWithSseFallbackClient.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/streamableHttpWithSseFallbackClient.ts)

For the detailed protocol rules, see the “Backwards compatibility” section of the MCP spec.
