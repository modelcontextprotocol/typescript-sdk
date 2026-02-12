---
title: Server Guide
---

# Building MCP servers

This guide covers the TypeScript SDK APIs for building MCP servers. For protocol-level concepts — what tools, resources, and prompts are and when to use each — see the [MCP overview](https://modelcontextprotocol.io/docs/learn/architecture).

Building a server takes three steps:

1. Create an {@linkcode @modelcontextprotocol/server!server/mcp.McpServer | McpServer} and register your [tools](#tools), [resources](#resources), and [prompts](#prompts).
2. Create a transport — [Streamable HTTP](#streamable-http) for remote servers or [stdio](#stdio) for local integrations.
3. Connect them with `server.connect(transport)`.

## Imports

The examples below use these imports. Adjust based on which features and transport you need:

```ts source="../examples/server/src/serverGuide.examples.ts#imports"
import { randomUUID } from 'node:crypto';

import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { CallToolResult, ResourceLink } from '@modelcontextprotocol/server';
import { completable, McpServer, ResourceTemplate, StdioServerTransport } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
```

## Transports

MCP supports two transport mechanisms (see [Transport layer](https://modelcontextprotocol.io/docs/learn/architecture#transport-layer) in the MCP overview). Choose based on deployment model:

- **Streamable HTTP** — for remote servers accessible over the network.
- **stdio** — for local servers spawned as child processes (Claude Desktop, CLI tools).

### Streamable HTTP

Create a {@linkcode @modelcontextprotocol/node!streamableHttp.NodeStreamableHTTPServerTransport | NodeStreamableHTTPServerTransport} and connect it to your server:

```ts source="../examples/server/src/serverGuide.examples.ts#streamableHttp_stateful"
const server = new McpServer({ name: 'my-server', version: '1.0.0' });

const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID()
});

await server.connect(transport);
```

**Options:** Set `sessionIdGenerator` to a function (shown above) for stateful sessions. Set it to `undefined` for stateless mode (simpler, but does not support resumability). Set `enableJsonResponse: true` to return plain JSON instead of SSE streams.

For a complete server with sessions, logging, and CORS mounted on Express, see [`simpleStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/simpleStreamableHttp.ts).

### stdio

For local, process-spawned integrations, use {@linkcode @modelcontextprotocol/server!server/stdio.StdioServerTransport | StdioServerTransport}:

```ts source="../examples/server/src/serverGuide.examples.ts#stdio_basic"
const server = new McpServer({ name: 'my-server', version: '1.0.0' });
const transport = new StdioServerTransport();
await server.connect(transport);
```

## Tools

Tools let clients invoke actions on your server — they are usually the main way LLMs call into your application (see [Tools](https://modelcontextprotocol.io/docs/learn/server-concepts#tools) in the MCP overview).

Register a tool with {@linkcode @modelcontextprotocol/server!server/mcp.McpServer#registerTool | registerTool}. Provide an `inputSchema` (Zod) to validate arguments, and optionally an `outputSchema` for structured return values:

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

### `ResourceLink` outputs

Tools can return `resource_link` content items to reference large resources without embedding them, letting clients fetch only what they need:

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

### Tool annotations

Tools can include annotations that hint at their behavior — whether a tool is read-only, destructive, or idempotent. Annotations help clients present tools appropriately without changing execution semantics:

```ts source="../examples/server/src/serverGuide.examples.ts#registerTool_annotations"
server.registerTool(
    'delete-file',
    {
        description: 'Delete a file from the project',
        inputSchema: z.object({ path: z.string() }),
        annotations: {
            title: 'Delete File',
            destructiveHint: true,
            idempotentHint: true
        }
    },
    async ({ path }): Promise<CallToolResult> => {
        // ... perform deletion ...
        return { content: [{ type: 'text', text: `Deleted ${path}` }] };
    }
);
```

### Error handling

Return `isError: true` to report tool-level errors. The LLM sees these and can self-correct, unlike protocol-level errors which are hidden from it:

```ts source="../examples/server/src/serverGuide.examples.ts#registerTool_errorHandling"
server.registerTool(
    'fetch-data',
    {
        description: 'Fetch data from a URL',
        inputSchema: z.object({ url: z.string() })
    },
    async ({ url }): Promise<CallToolResult> => {
        try {
            const res = await fetch(url);
            if (!res.ok) {
                return {
                    content: [{ type: 'text', text: `HTTP ${res.status}: ${res.statusText}` }],
                    isError: true
                };
            }
            const text = await res.text();
            return { content: [{ type: 'text', text }] };
        } catch (error) {
            return {
                content: [{ type: 'text', text: `Failed: ${error instanceof Error ? error.message : String(error)}` }],
                isError: true
            };
        }
    }
);
```

If a handler throws instead of returning `isError`, the SDK catches the exception and converts it to `{ isError: true }` automatically — so an explicit try/catch is optional but gives you control over the error message. When `isError` is true, output schema validation is skipped.

## Resources

Resources expose read-only data — files, database schemas, configuration — that the host application can retrieve and attach as context for the model (see [Resources](https://modelcontextprotocol.io/docs/learn/server-concepts#resources) in the MCP overview). Unlike [tools](#tools), which the LLM invokes on its own, resources are application-controlled: the host decides which resources to fetch and how to present them.

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

Dynamic resources use {@linkcode @modelcontextprotocol/server!server/mcp.ResourceTemplate | ResourceTemplate} with URI patterns. The `list` callback lets clients discover available instances:

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

## Prompts

Prompts are reusable templates that help structure interactions with models (see [Prompts](https://modelcontextprotocol.io/docs/learn/server-concepts#prompts) in the MCP overview). Use a prompt when you want to offer a canned interaction pattern that users invoke explicitly; use a [tool](#tools) when the LLM should decide when to call it.

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

## Completions

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

## Logging

Logging lets your server send structured diagnostics — debug traces, progress updates, warnings — to the connected client as notifications (see [Logging](https://modelcontextprotocol.io/specification/latest/server/utilities/logging) in the MCP specification).

Declare the `logging` capability, then call `ctx.mcpReq.log(level, data)` (from {@linkcode @modelcontextprotocol/server!index.ServerContext | ServerContext}) inside any handler:

```ts source="../examples/server/src/serverGuide.examples.ts#logging_capability"
const server = new McpServer({ name: 'my-server', version: '1.0.0' }, { capabilities: { logging: {} } });
```

Then log from any handler:

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

## Server-initiated requests

MCP is bidirectional — servers can send requests *to* the client during tool execution, as long as the client declares matching capabilities (see [Architecture](https://modelcontextprotocol.io/docs/learn/architecture) in the MCP overview).

### Sampling

Sampling lets a tool handler request an LLM completion from the connected client — the handler describes a prompt and the client returns the model's response (see [Sampling](https://modelcontextprotocol.io/docs/learn/client-concepts#sampling) in the MCP overview). Use sampling when a tool needs the model to generate or transform text mid-execution.

Call `ctx.mcpReq.requestSampling(params)` (from {@linkcode @modelcontextprotocol/server!index.ServerContext | ServerContext}) inside a tool handler:

```ts source="../examples/server/src/serverGuide.examples.ts#registerTool_sampling"
server.registerTool(
    'summarize',
    {
        description: 'Summarize text using the client LLM',
        inputSchema: z.object({ text: z.string() })
    },
    async ({ text }, ctx): Promise<CallToolResult> => {
        const response = await ctx.mcpReq.requestSampling({
            messages: [
                {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: `Please summarize:\n\n${text}`
                    }
                }
            ],
            maxTokens: 500
        });
        return {
            content: [
                {
                    type: 'text',
                    text: `Model (${response.model}): ${JSON.stringify(response.content)}`
                }
            ]
        };
    }
);
```

For a full runnable example, see [`toolWithSampleServer.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/toolWithSampleServer.ts).

### Elicitation

Elicitation lets a tool handler request direct input from the user — form fields, confirmations, or a redirect to a URL (see [Elicitation](https://modelcontextprotocol.io/docs/learn/client-concepts#elicitation) in the MCP overview). It supports two modes:

- **Form** (`mode: 'form'`) — collects non-sensitive data via a schema-driven form.
- **URL** (`mode: 'url'`) — opens a browser URL for sensitive data or secure flows (API keys, payments, OAuth).

> [!IMPORTANT]
> Sensitive information must not be collected via form elicitation; always use URL elicitation or out-of-band flows for secrets.

Call `ctx.mcpReq.elicitInput(params)` (from {@linkcode @modelcontextprotocol/server!index.ServerContext | ServerContext}) inside a tool handler:

```ts source="../examples/server/src/serverGuide.examples.ts#registerTool_elicitation"
server.registerTool(
    'collect-feedback',
    {
        description: 'Collect user feedback via a form',
        inputSchema: z.object({})
    },
    async (_args, ctx): Promise<CallToolResult> => {
        const result = await ctx.mcpReq.elicitInput({
            mode: 'form',
            message: 'Please share your feedback:',
            requestedSchema: {
                type: 'object',
                properties: {
                    rating: {
                        type: 'number',
                        title: 'Rating (1\u20135)',
                        minimum: 1,
                        maximum: 5
                    },
                    comment: { type: 'string', title: 'Comment' }
                },
                required: ['rating']
            }
        });
        if (result.action === 'accept') {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Thanks! ${JSON.stringify(result.content)}`
                    }
                ]
            };
        }
        return { content: [{ type: 'text', text: 'Feedback declined.' }] };
    }
);
```

For runnable examples, see [`elicitationFormExample.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/elicitationFormExample.ts) (form) and [`elicitationUrlExample.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/elicitationUrlExample.ts) (URL).

## Tasks (experimental)

> [!WARNING]
> The tasks API is experimental and may change without notice.

Task-based execution enables "call-now, fetch-later" patterns for long-running operations (see [Tasks](https://modelcontextprotocol.io/specification/latest/basic/utilities/tasks) in the MCP specification). Instead of returning a result immediately, a tool creates a task that can be polled or resumed later. To use tasks:

- Provide a {@linkcode @modelcontextprotocol/server!index.TaskStore | TaskStore} implementation that persists task metadata and results (see {@linkcode @modelcontextprotocol/server!index.InMemoryTaskStore | InMemoryTaskStore} for reference).
- Enable the `tasks` capability when constructing the server.
- Register tools with {@linkcode @modelcontextprotocol/server!experimental/tasks/mcpServer.ExperimentalMcpServerTasks#registerToolTask | server.experimental.tasks.registerToolTask(...)}.

For a full runnable example, see [`simpleTaskInteractive.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/simpleTaskInteractive.ts).

## Shutdown

For stateful multi-session HTTP servers, capture the `http.Server` from `app.listen()` so you can stop accepting connections, then close each session transport:

```ts source="../examples/server/src/serverGuide.examples.ts#shutdown_statefulHttp"
// Capture the http.Server so it can be closed on shutdown
const httpServer = app.listen(3000);

process.on('SIGINT', async () => {
    httpServer.close();

    for (const [sessionId, transport] of transports) {
        await transport.close();
        transports.delete(sessionId);
    }

    process.exit(0);
});
```

Calling {@linkcode @modelcontextprotocol/server!index.Transport#close | transport.close()} closes SSE streams and rejects any pending outbound requests. In-flight tool handlers are not automatically drained — they are terminated when the process exits.

For stdio servers, {@linkcode @modelcontextprotocol/server!server/mcp.McpServer#close | server.close()} is sufficient:

```ts source="../examples/server/src/serverGuide.examples.ts#shutdown_stdio"
process.on('SIGINT', async () => {
    await server.close();
    process.exit(0);
});
```

For a complete multi-session server with shutdown handling, see [`simpleStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/simpleStreamableHttp.ts).

## Deployment

### DNS rebinding protection

MCP servers running on localhost are vulnerable to DNS rebinding attacks. Use {@linkcode @modelcontextprotocol/express!express.createMcpExpressApp | createMcpExpressApp()} from `@modelcontextprotocol/express` to create an Express app with DNS rebinding protection enabled by default:

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

## See also

- [`examples/server/`](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/examples/server) — Full runnable server examples
- [Client guide](./client.md) — Building MCP clients with this SDK
- [MCP overview](https://modelcontextprotocol.io/docs/learn/architecture) — Protocol-level concepts: participants, layers, primitives
- [Migration guide](./migration.md) — Upgrading from previous SDK versions
- [FAQ](./faq.md) — Frequently asked questions and troubleshooting

### Additional examples

| Feature | Description | Example |
|---------|-------------|---------|
| Web Standard transport | Deploy on Cloudflare Workers, Deno, or Bun | [`honoWebStandardStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/honoWebStandardStreamableHttp.ts) |
| Session management | Per-session transport routing, initialization, and cleanup | [`simpleStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/simpleStreamableHttp.ts) |
| Resumability | Replay missed SSE events via an event store | [`inMemoryEventStore.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/inMemoryEventStore.ts) |
| CORS | Expose MCP headers for browser clients | [`simpleStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/src/simpleStreamableHttp.ts) |
| Multi-node deployment | Stateless, persistent-storage, and distributed routing patterns | [`examples/server/README.md`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/server/README.md#multi-node-deployment-patterns) |
