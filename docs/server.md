---
title: Server
---

## Server overview

This SDK lets you build MCP servers in TypeScript and connect them to different transports. For most use cases you will use `McpServer` from `@modelcontextprotocol/server` and choose one of:

- **Streamable HTTP** (for remote servers)
- **stdio** (for local, process‑spawned integrations)

For a complete, runnable example server, see:

- [`simpleStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/simpleStreamableHttp.ts) – feature‑rich Streamable HTTP server
- [`jsonResponseStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/jsonResponseStreamableHttp.ts) – Streamable HTTP with JSON response mode
- [`simpleStatelessStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/simpleStatelessStreamableHttp.ts) – stateless Streamable HTTP server

## Transports

### Streamable HTTP

Streamable HTTP is the HTTP‑based transport. It supports:

- Request/response over HTTP POST
- Server‑to‑client notifications over SSE (when enabled)
- Optional JSON‑only response mode with no SSE
- Session management and resumability

A minimal stateful setup:

```ts source="../examples/server/src/serverGuide.examples.ts#streamableHttp_stateful"
const server = new McpServer({ name: 'my-server', version: '1.0.0' });

const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID()
});

await server.connect(transport);
```

> [!NOTE]
> For full runnable examples, see [`simpleStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/simpleStreamableHttp.ts) (sessions, logging, tasks, elicitation, auth hooks), [`jsonResponseStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/jsonResponseStreamableHttp.ts) (`enableJsonResponse: true`, no SSE), and [`standaloneSseWithGetStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/standaloneSseWithGetStreamableHttp.ts) (notifications with Streamable HTTP GET + SSE).

See the MCP spec for full transport details: `https://modelcontextprotocol.io/specification/2025-11-25/basic/transports`

### Stateless vs stateful sessions

Streamable HTTP can run:

- **Stateless** – no session tracking, ideal for simple API‑style servers.
- **Stateful** – sessions have IDs, and you can enable resumability and advanced features.

The key difference is the `sessionIdGenerator` option. Pass `undefined` for stateless mode:

```ts source="../examples/server/src/serverGuide.examples.ts#streamableHttp_stateless"
const server = new McpServer({ name: 'my-server', version: '1.0.0' });

const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: undefined
});

await server.connect(transport);
```

> [!NOTE]
> For full runnable examples, see [`simpleStatelessStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/simpleStatelessStreamableHttp.ts) (stateless) and [`simpleStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/simpleStreamableHttp.ts) (stateful with resumability).

## Running your server

For a minimal "getting started" experience:

1. Register your tools, resources, and prompts (see [below](#tools-resources-and-prompts)).
2. Create a transport and connect it to your server.
3. Wire the transport into your HTTP framework or use stdio.

For more detailed patterns (stateless vs stateful, JSON response mode, CORS, DNS rebind protection), see the examples and the MCP spec sections on transports.

> [!NOTE]
> For a feature‑rich starting point, see [`simpleStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/simpleStreamableHttp.ts). Remove features you do not need (tasks, advanced logging, OAuth, etc.) and register your own tools, resources and prompts.

## DNS rebinding protection

MCP servers running on localhost are vulnerable to DNS rebinding attacks. Use `createMcpExpressApp()` from `@modelcontextprotocol/express` to create an Express app with DNS rebinding protection enabled by default:

```ts source="../examples/server/src/serverGuide.examples.ts#dnsRebinding_basic"
// Default: DNS rebinding protection auto-enabled (host is 127.0.0.1)
const app = createMcpExpressApp();

// DNS rebinding protection also auto-enabled for localhost
const appLocal = createMcpExpressApp({ host: 'localhost' });

// No automatic protection when binding to all interfaces
const appOpen = createMcpExpressApp({ host: '0.0.0.0' });
```

When binding to `0.0.0.0` / `::`, provide an allow-list of hosts:

```ts source="../examples/server/src/serverGuide.examples.ts#dnsRebinding_allowedHosts"
const app = createMcpExpressApp({
    host: '0.0.0.0',
    allowedHosts: ['localhost', '127.0.0.1', 'myhost.local']
});
```

## Tools, resources, and prompts

### Tools

Tools let MCP clients ask your server to take actions. They are usually the main way that LLMs call into your application.

A typical registration with `registerTool`:

```ts source="../examples/server/src/serverGuide.examples.ts#registerTool_basic"
server.registerTool(
    'calculate-bmi',
    {
        title: 'BMI Calculator',
        description: 'Calculate Body Mass Index',
        inputSchema: z.object({
            weightKg: z.number(),
            heightM: z.number()
        }),
        outputSchema: z.object({ bmi: z.number() })
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

> [!NOTE]
> For full runnable examples, see [`simpleStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/simpleStreamableHttp.ts) and [`toolWithSampleServer.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/toolWithSampleServer.ts).

#### ResourceLink outputs

Tools can return `resource_link` content items to reference large resources without embedding them directly, allowing clients to fetch only what they need:

```ts source="../examples/server/src/serverGuide.examples.ts#registerTool_resourceLink"
server.registerTool(
    'list-files',
    {
        title: 'List Files',
        description: 'Returns files as resource links without embedding content'
    },
    async (): Promise<CallToolResult> => {
        const links: ResourceLink[] = [
            {
                type: 'resource_link',
                uri: 'file:///projects/readme.md',
                name: 'README',
                mimeType: 'text/markdown'
            },
            {
                type: 'resource_link',
                uri: 'file:///projects/config.json',
                name: 'Config',
                mimeType: 'application/json'
            }
        ];
        return { content: links };
    }
);
```

> [!NOTE]
> For a full runnable example with `ResourceLink` outputs, see [`simpleStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/simpleStreamableHttp.ts).

### Resources

Resources expose data to clients, but should not perform heavy computation or side‑effects. They are ideal for configuration, documents, or other reference data.

A static resource at a fixed URI:

```ts source="../examples/server/src/serverGuide.examples.ts#registerResource_static"
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

Dynamic resources use `ResourceTemplate` and can support completions on path parameters:

```ts source="../examples/server/src/serverGuide.examples.ts#registerResource_template"
server.registerResource(
    'user-profile',
    new ResourceTemplate('user://{userId}/profile', {
        list: async () => ({
            resources: [
                { uri: 'user://123/profile', name: 'Alice' },
                { uri: 'user://456/profile', name: 'Bob' }
            ]
        })
    }),
    {
        title: 'User Profile',
        description: 'User profile data',
        mimeType: 'application/json'
    },
    async (uri, { userId }) => ({
        contents: [
            {
                uri: uri.href,
                text: JSON.stringify({ userId, name: 'Example User' })
            }
        ]
    })
);
```

> [!NOTE]
> For full runnable examples of resources, see [`simpleStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/simpleStreamableHttp.ts).

### Prompts

Prompts are reusable templates that help humans (or client UIs) talk to models in a consistent way. They are declared on the server and listed through MCP.

A minimal prompt:

```ts source="../examples/server/src/serverGuide.examples.ts#registerPrompt_basic"
server.registerPrompt(
    'review-code',
    {
        title: 'Code Review',
        description: 'Review code for best practices and potential issues',
        argsSchema: z.object({
            code: z.string()
        })
    },
    ({ code }) => ({
        messages: [
            {
                role: 'user' as const,
                content: {
                    type: 'text' as const,
                    text: `Please review this code:\n\n${code}`
                }
            }
        ]
    })
);
```

> [!NOTE]
> For prompts integrated into a full server, see [`simpleStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/simpleStreamableHttp.ts).

### Completions

Both prompts and resources can support argument completions. Wrap a field in the `argsSchema` with `completable()` to provide autocompletion suggestions:

```ts source="../examples/server/src/serverGuide.examples.ts#registerPrompt_completion"
server.registerPrompt(
    'review-code',
    {
        title: 'Code Review',
        description: 'Review code for best practices',
        argsSchema: z.object({
            language: completable(z.string().describe('Programming language'), value =>
                ['typescript', 'javascript', 'python', 'rust', 'go'].filter(lang => lang.startsWith(value))
            )
        })
    },
    ({ language }) => ({
        messages: [
            {
                role: 'user' as const,
                content: {
                    type: 'text' as const,
                    text: `Review this ${language} code for best practices.`
                }
            }
        ]
    })
);
```

For client-side completion usage, see the [Client guide](client.md).

## Multi‑node deployment patterns

The SDK supports multi‑node deployments using Streamable HTTP. The high‑level patterns and diagrams live with the runnable server examples:

- [`examples/server/README.md`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/README.md#multi-node-deployment-patterns)

