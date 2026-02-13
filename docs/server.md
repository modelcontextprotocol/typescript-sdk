---
title: Server
---

## Server overview

This guide covers SDK usage for building MCP servers in TypeScript. For protocol-level details and message formats, see the [MCP specification](https://modelcontextprotocol.io/specification/latest/).

Building a server takes three steps:

1. Create an {@linkcode @modelcontextprotocol/server!server/mcp.McpServer | McpServer} and register your [tools, resources, and prompts](#tools-resources-and-prompts).
2. Create a transport — [Streamable HTTP](#streamable-http) for remote servers or [stdio](#stdio) for local, process‑spawned integrations.
3. Wire the transport into your HTTP framework (or use stdio directly) and call `server.connect(transport)`.

The sections below cover each of these. For a feature‑rich starting point, see [`simpleStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/simpleStreamableHttp.ts) — remove what you don't need and register your own tools, resources, and prompts. For stateless or JSON‑response‑mode alternatives, see the examples linked in [Transports](#transports) below.

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
>
> For protocol details, see [Transports](https://modelcontextprotocol.io/specification/latest/basic/transports) in the MCP specification.

#### Stateless vs stateful sessions

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

#### JSON response mode

If you do not need SSE streaming, set `enableJsonResponse: true`. The server will return plain JSON responses to every POST and reject GET requests with `405`:

```ts source="../examples/server/src/serverGuide.examples.ts#streamableHttp_jsonResponse"
const server = new McpServer({ name: 'my-server', version: '1.0.0' });

const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true
});

await server.connect(transport);
```

> [!NOTE]
> For a full runnable example, see [`jsonResponseStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/jsonResponseStreamableHttp.ts).

### stdio

For local, process‑spawned integrations (Claude Desktop, CLI tools), use {@linkcode @modelcontextprotocol/server!server/stdio.StdioServerTransport | StdioServerTransport}:

```ts source="../examples/server/src/serverGuide.examples.ts#stdio_basic"
const server = new McpServer({ name: 'my-server', version: '1.0.0' });
const transport = new StdioServerTransport();
await server.connect(transport);
```

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

A typical registration with {@linkcode @modelcontextprotocol/server!server/mcp.McpServer#registerTool | registerTool}:

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
>
> For protocol details, see [Tools](https://modelcontextprotocol.io/specification/latest/server/tools) in the MCP specification.

#### `ResourceLink` outputs

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

#### Logging

Use `ctx.mcpReq.log(level, data)` (from {@linkcode @modelcontextprotocol/server!index.ServerContext | ServerContext}) inside a tool handler to send structured log messages to the client. The server must declare the `logging` capability:

```ts source="../examples/server/src/serverGuide.examples.ts#logging_capability"
const server = new McpServer({ name: 'my-server', version: '1.0.0' }, { capabilities: { logging: {} } });
```

Then log from any tool callback:

```ts source="../examples/server/src/serverGuide.examples.ts#registerTool_logging"
server.registerTool(
    'fetch-data',
    {
        description: 'Fetch data from an API',
        inputSchema: z.object({ url: z.string() })
    },
    async ({ url }, ctx): Promise<CallToolResult> => {
        await ctx.mcpReq.log('info', `Fetching ${url}`);
        const res = await fetch(url);
        await ctx.mcpReq.log('debug', `Response status: ${res.status}`);
        const text = await res.text();
        return { content: [{ type: 'text', text }] };
    }
);
```

> [!NOTE]
> For logging in a full server, see [`simpleStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/simpleStreamableHttp.ts) and [`jsonResponseStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/jsonResponseStreamableHttp.ts).
>
> For protocol details, see [Logging](https://modelcontextprotocol.io/specification/latest/server/utilities/logging) in the MCP specification.

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

Dynamic resources use {@linkcode @modelcontextprotocol/server!server/mcp.ResourceTemplate | ResourceTemplate} and can support completions on path parameters:

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
>
> For protocol details, see [Resources](https://modelcontextprotocol.io/specification/latest/server/resources) in the MCP specification.

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
>
> For protocol details, see [Prompts](https://modelcontextprotocol.io/specification/latest/server/prompts) in the MCP specification.

### Completions

Both prompts and resources can support argument completions. Wrap a field in the `argsSchema` with {@linkcode @modelcontextprotocol/server!server/completable.completable | completable()} to provide autocompletion suggestions:

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

## More server features

The sections above cover the essentials. The SDK supports several additional capabilities — each is demonstrated in the runnable examples and covered in more detail in the linked references.

| Feature | Description | Reference |
|---------|-------------|-----------|
| Web Standard transport | Deploy on Cloudflare Workers, Deno, or Bun | [`honoWebStandardStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/honoWebStandardStreamableHttp.ts) |
| Session management | Per-session transport routing, initialization, and cleanup | [`simpleStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/simpleStreamableHttp.ts) |
| Resumability | Replay missed SSE events via an event store | [`inMemoryEventStore.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/inMemoryEventStore.ts) |
| CORS | Expose MCP headers (`mcp-session-id`, etc.) for browser clients | [`simpleStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/simpleStreamableHttp.ts) |
| Tool annotations | Hint whether tools are read-only, destructive, etc. | [`simpleStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/simpleStreamableHttp.ts) |
| Elicitation | Request user input (forms or URLs) during tool execution | [Capabilities guide](capabilities.md#elicitation), [`elicitationFormExample.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/elicitationFormExample.ts) |
| Sampling | Request LLM completions from the connected client | [Capabilities guide](capabilities.md#sampling), [`toolWithSampleServer.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/toolWithSampleServer.ts) |
| Tasks (experimental) | Long-running operations with polling and resumption | [Capabilities guide](capabilities.md#task-based-execution-experimental), [`simpleStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/simpleStreamableHttp.ts) |
| Multi‑node deployment | Stateless, persistent‑storage, and distributed routing patterns | [`examples/server/README.md`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/README.md#multi-node-deployment-patterns) |
