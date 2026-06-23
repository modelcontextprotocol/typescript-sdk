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

```ts source="../examples/guides/serverGuide.examples.ts#imports"
import { randomUUID } from 'node:crypto';

import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { CallToolResult, ResourceLink } from '@modelcontextprotocol/server';
import { completable, McpServer, ResourceTemplate, TRACEPARENT_META_KEY } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
```

## Transports

MCP supports two transport mechanisms (see [Transport layer](https://modelcontextprotocol.io/docs/learn/architecture#transport-layer) in the MCP overview). Choose based on deployment model:

- **Streamable HTTP** — for remote servers accessible over the network.
- **stdio** — for local servers spawned as child processes (Claude Desktop, CLI tools).

### Streamable HTTP

Create a {@linkcode @modelcontextprotocol/node!streamableHttp.NodeStreamableHTTPServerTransport | NodeStreamableHTTPServerTransport} and connect it to your server:

```ts source="../examples/guides/serverGuide.examples.ts#streamableHttp_stateful"
const server = new McpServer({ name: 'my-server', version: '1.0.0' });

const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID()
});

await server.connect(transport);
```

**Options:** Set `sessionIdGenerator` to a function (shown above) for stateful sessions. Set it to `undefined` for stateless mode (simpler, but does not support resumability). Set `enableJsonResponse: true` to return plain JSON instead of SSE streams.

For a complete server with sessions and the browser-client CORS recipe, see [`legacy-routing/server.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/legacy-routing/server.ts).

### stdio

For local, process-spawned integrations, use {@linkcode @modelcontextprotocol/server!server/stdio.StdioServerTransport | StdioServerTransport}:

```ts source="../examples/guides/serverGuide.examples.ts#stdio_basic"
const server = new McpServer({ name: 'my-server', version: '1.0.0' });
const transport = new StdioServerTransport();
await server.connect(transport);
```

#### Serving the 2026-07-28 draft revision on stdio

A hand-constructed stdio server speaks the 2025-era protocol it was written for: nothing about its wire behavior changes when you upgrade the SDK. Serving the 2026-07-28 draft revision goes through the connection-pinned `serveStdio` entry, which mirrors `createMcpHandler` for
long-lived connections — the entry owns the transport and the era decision, and one instance from your factory serves the era the client opened the connection with:

```typescript
import { serveStdio } from '@modelcontextprotocol/server/stdio';

serveStdio(() => {
    const server = new McpServer({ name: 'my-server', version: '1.0.0' }, { capabilities: { tools: {} } });
    // register tools/resources/prompts once — the same factory serves both eras
    return server;
});
```

Plain 2025 clients open with `initialize` and are served exactly as before; 2026-capable clients negotiate via `server/discover` and send each request with the per-request `_meta` envelope, and their connection is pinned to a 2026-era instance. Pass `legacy: 'reject'` to refuse
2025-era openings with the unsupported-protocol-version error. On 2026-pinned connections, read per-request client identity from `ctx.mcpReq.envelope` in your handlers rather than the connection-scoped accessors (see the [migration guide](./migration.md) for details). A runnable
example lives at `examples/dual-era/server.ts`, with a two-legged client at `examples/dual-era/client.ts`.

## Server instructions

Instructions describe how to use the server and its features — cross-tool relationships, workflow patterns, and constraints (see [Instructions](https://modelcontextprotocol.io/specification/latest/basic/lifecycle#instructions) in the MCP specification). Clients may add them to
the system prompt. Instructions should not duplicate information already in tool descriptions.

```ts source="../examples/guides/serverGuide.examples.ts#instructions_basic"
const server = new McpServer(
    { name: 'db-server', version: '1.0.0' },
    {
        instructions:
            'Always call list_tables before running queries. Use validate_schema before migrate_schema for safe migrations. Results are limited to 1000 rows.'
    }
);
```

## Tools

Tools let clients invoke actions on your server — they are usually the main way LLMs call into your application (see [Tools](https://modelcontextprotocol.io/docs/learn/server-concepts#tools) in the MCP overview).

Register a tool with {@linkcode @modelcontextprotocol/server!server/mcp.McpServer#registerTool | registerTool}. Provide an `inputSchema` (Zod) to validate arguments, and optionally an `outputSchema` for structured return values.

> On the 2026-07-28 draft serving path, a tool whose `inputSchema` carries an `x-mcp-header` annotation has that argument mirrored into an `Mcp-Param-{Name}` HTTP request header by conforming clients. `createMcpHandler` validates those headers before dispatch and rejects a
> `tools/call` whose `Mcp-Param-*` headers are missing for a present body value, malformed, or disagree with the body — `400 Bad Request` with JSON-RPC `-32020` (`HeaderMismatch`). `registerTool` warns at registration time when an `x-mcp-header` declaration violates the
> spec's constraints. The 2025-era serving paths and the low-level `Server` factory shape are unchanged.

```ts source="../examples/guides/serverGuide.examples.ts#registerTool_basic"
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
> When defining a named type for `structuredContent`, use a `type` alias rather than an `interface`. Named interfaces lack implicit index signatures in TypeScript, so they aren't assignable to `{ [key: string]: unknown }`:
>
> ```ts
> type BmiResult = { bmi: number }; // assignable
> interface BmiResult {
>     bmi: number;
> } // type error
> ```
>
> Alternatively, spread the value: `structuredContent: { ...result }`.

### `ResourceLink` outputs

Tools can return `resource_link` content items to reference large resources without embedding them, letting clients fetch only what they need:

```ts source="../examples/guides/serverGuide.examples.ts#registerTool_resourceLink"
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

```ts source="../examples/guides/serverGuide.examples.ts#registerTool_annotations"
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

### Icons

Tools, prompts, resources, and resource templates can advertise `icons` that a client may render in its UI — the same field is also accepted on your server's `Implementation` info. Each icon needs a `src` (a URL or `data:` URI) and may add a `mimeType`, the `sizes` it suits (`"WxH"` strings, or `"any"` for scalable formats like SVG), and a `theme` (`light` or `dark`). Icons are passed straight through to the relevant list response, such as `tools/list`:

```ts source="../examples/guides/serverGuide.examples.ts#registerTool_icons"
server.registerTool(
    'generate-chart',
    {
        title: 'Generate Chart',
        description: 'Render a chart from a series of numbers',
        inputSchema: z.object({ data: z.array(z.number()) }),
        // Icons a client may render in its UI. `src` is required; `mimeType`,
        // `sizes`, and `theme` ('light' | 'dark') are optional hints.
        icons: [
            { src: 'https://example.com/icons/chart.svg', mimeType: 'image/svg+xml', sizes: ['any'] },
            { src: 'https://example.com/icons/chart-48.png', mimeType: 'image/png', sizes: ['48x48'], theme: 'light' }
        ]
    },
    async ({ data }): Promise<CallToolResult> => {
        // ... render chart ...
        return { content: [{ type: 'text', text: `Charted ${data.length} points` }] };
    }
);
```

> [!NOTE]
> Clients that render icons must support `image/png` and `image/jpeg`, and should also support `image/svg+xml` and `image/webp`. Pass the same `icons` field to `registerPrompt`, `registerResource`, and the `McpServer` constructor's server-info object to advertise icons for prompts, resources, and the server itself.

### Error handling

Return `isError: true` to report tool-level errors. The LLM sees these and can self-correct, unlike protocol-level errors which are hidden from it:

```ts source="../examples/guides/serverGuide.examples.ts#registerTool_errorHandling"
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

Resources expose read-only data — files, database schemas, configuration — that the host application can retrieve and attach as context for the model (see [Resources](https://modelcontextprotocol.io/docs/learn/server-concepts#resources) in the MCP overview). Unlike
[tools](#tools), which the LLM invokes on its own, resources are application-controlled: the host decides which resources to fetch and how to present them.

A static resource at a fixed URI:

```ts source="../examples/guides/serverGuide.examples.ts#registerResource_static"
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

```ts source="../examples/guides/serverGuide.examples.ts#registerResource_template"
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

> [!IMPORTANT]
> **Security note:** If a resource is backed by the filesystem (for example, a `file://` server or a template whose variables map onto file paths), the spec requires sanitizing any user-influenced path before use. Resolve the requested path and verify it stays within
> the intended root directory, rejecting traversal sequences such as `..` (including encoded forms) and symlinks that escape the root. Never pass template variables or client-supplied URIs to filesystem APIs unchecked.

## Prompts

Prompts are reusable templates that help structure interactions with models (see [Prompts](https://modelcontextprotocol.io/docs/learn/server-concepts#prompts) in the MCP overview). Use a prompt when you want to offer a canned interaction pattern that users invoke explicitly; use
a [tool](#tools) when the LLM should decide when to call it.

```ts source="../examples/guides/serverGuide.examples.ts#registerPrompt_basic"
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

```ts source="../examples/guides/serverGuide.examples.ts#registerPrompt_completion"
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

> [!WARNING]
> MCP logging is deprecated as of protocol version 2026-07-28 (SEP-2577). It remains fully functional during the deprecation window (at least twelve months); see the [deprecated features registry](https://modelcontextprotocol.io/specification/draft/deprecated). Migrate
> to stderr logging (STDIO servers) or OpenTelemetry.

Logging lets your server send structured diagnostics — debug traces, progress updates, warnings — to the connected client as notifications (see [Logging](https://modelcontextprotocol.io/specification/latest/server/utilities/logging) in the MCP specification).

Declare the `logging` capability, then call `ctx.mcpReq.log(level, data)` (from {@linkcode @modelcontextprotocol/server!index.ServerContext | ServerContext}) inside any handler:

```ts source="../examples/guides/serverGuide.examples.ts#logging_capability"
const server = new McpServer({ name: 'my-server', version: '1.0.0' }, { capabilities: { logging: {} } });
```

Then log from any handler:

```ts source="../examples/guides/serverGuide.examples.ts#registerTool_logging"
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

## Progress

Progress notifications let a tool report incremental status updates during long-running operations (see [Progress](https://modelcontextprotocol.io/specification/latest/basic/utilities/progress) in the MCP specification).

If the client includes a `progressToken` in the request `_meta`, send `notifications/progress` via `ctx.mcpReq.notify()` (from {@linkcode @modelcontextprotocol/server!index.BaseContext | BaseContext}):

```ts source="../examples/guides/serverGuide.examples.ts#registerTool_progress"
server.registerTool(
    'process-files',
    {
        description: 'Process files with progress updates',
        inputSchema: z.object({ files: z.array(z.string()) })
    },
    async ({ files }, ctx): Promise<CallToolResult> => {
        const progressToken = ctx.mcpReq._meta?.progressToken;

        for (let i = 0; i < files.length; i++) {
            // ... process files[i] ...

            if (progressToken !== undefined) {
                await ctx.mcpReq.notify({
                    method: 'notifications/progress',
                    params: {
                        progressToken,
                        progress: i + 1,
                        total: files.length,
                        message: `Processed ${files[i]}`
                    }
                });
            }
        }

        return { content: [{ type: 'text', text: `Processed ${files.length} files` }] };
    }
);
```

`progress` must increase on each call. `total` and `message` are optional. If the client does not provide a `progressToken`, skip the notification.

## Trace context propagation

The MCP specification ([SEP-414](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/414)) reserves the unprefixed `_meta` keys `traceparent`, `tracestate`, and `baggage` for distributed trace context, as an exception to the usual `_meta` key prefix rule. When
present, the values must follow the [W3C Trace Context](https://www.w3.org/TR/trace-context/) and [W3C Baggage](https://www.w3.org/TR/baggage/) formats. The SDK does not interpret these keys — `_meta` passes through untouched on any transport, including stdio. The key names are
exported as `TRACEPARENT_META_KEY`, `TRACESTATE_META_KEY`, and `BAGGAGE_META_KEY`.

Read the caller's trace context from `ctx.mcpReq._meta` in a handler:

```ts source="../examples/guides/serverGuide.examples.ts#registerTool_traceContext"
server.registerTool(
    'traced-operation',
    {
        description: 'Operation that participates in distributed tracing',
        inputSchema: z.object({ query: z.string() })
    },
    async ({ query }, ctx): Promise<CallToolResult> => {
        // e.g. '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
        const traceparent = ctx.mcpReq._meta?.[TRACEPARENT_META_KEY];
        if (typeof traceparent === 'string') {
            // Continue the caller's trace, e.g. start a child span with your
            // OpenTelemetry tracer using this trace context.
        }

        return { content: [{ type: 'text', text: `Results for ${query}` }] };
    }
);
```

To propagate context onward (for example on a server-initiated sampling request, or back on a response), set the same keys in the outgoing `_meta`. See the [client guide](./client.md#trace-context-propagation) for injecting trace context on the client side.

## Server-initiated requests

MCP is bidirectional — servers can send requests _to_ the client during tool execution, as long as the client declares matching capabilities (see [Architecture](https://modelcontextprotocol.io/docs/learn/architecture) in the MCP overview).

### Sampling

> [!WARNING]
> Sampling is deprecated as of protocol version 2026-07-28 (SEP-2577). It remains fully functional during the deprecation window (at least twelve months); see the [deprecated features registry](https://modelcontextprotocol.io/specification/draft/deprecated). Migrate to
> calling LLM provider APIs directly from your server.

Sampling lets a tool handler request an LLM completion from the connected client — the handler describes a prompt and the client returns the model's response (see [Sampling](https://modelcontextprotocol.io/docs/learn/client-concepts#sampling) in the MCP overview). Use sampling
when a tool needs the model to generate or transform text mid-execution.

Call `ctx.mcpReq.requestSampling(params)` (from {@linkcode @modelcontextprotocol/server!index.ServerContext | ServerContext}) inside a tool handler:

```ts source="../examples/guides/serverGuide.examples.ts#registerTool_sampling"
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

For a full runnable example, see [`sampling/server.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/sampling/server.ts).

### Elicitation

Elicitation lets a tool handler request direct input from the user — form fields, confirmations, or a redirect to a URL (see [Elicitation](https://modelcontextprotocol.io/docs/learn/client-concepts#elicitation) in the MCP overview). It supports two modes:

- **Form** (`mode: 'form'`) — collects non-sensitive data via a schema-driven form.
- **URL** (`mode: 'url'`) — opens a browser URL for sensitive data or secure flows (API keys, payments, OAuth).

> [!IMPORTANT]
> Sensitive information must not be collected via form elicitation; always use URL elicitation or out-of-band flows for secrets.

Call `ctx.mcpReq.elicitInput(params)` (from {@linkcode @modelcontextprotocol/server!index.ServerContext | ServerContext}) inside a tool handler:

```ts source="../examples/guides/serverGuide.examples.ts#registerTool_elicitation"
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

For runnable examples, see [`elicitation/server.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/elicitation/server.ts) (form + URL mode, both protocol eras) and
[`mrtr/server.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/mrtr/server.ts) (the secure `requestState` round-trip pattern).

### Roots

> [!WARNING]
> Roots are deprecated as of protocol version 2026-07-28 (SEP-2577). They remain fully functional during the deprecation window (at least twelve months); see the [deprecated features registry](https://modelcontextprotocol.io/specification/draft/deprecated). Migrate to
> passing paths via tool parameters, resource URIs, or configuration.

Roots let a tool handler discover the client's workspace directories — for example, to scope a file search or identify project boundaries (see [Roots](https://modelcontextprotocol.io/docs/learn/client-concepts#roots) in the MCP overview). Call {@linkcode
@modelcontextprotocol/server!server/server.Server#listRoots | server.server.listRoots()} (requires the client to declare the `roots` capability):

```ts source="../examples/guides/serverGuide.examples.ts#registerTool_roots"
server.registerTool(
    'list-workspace-files',
    {
        description: 'List files across all workspace roots',
        inputSchema: z.object({})
    },
    async (_args, _ctx): Promise<CallToolResult> => {
        const { roots } = await server.server.listRoots();
        const summary = roots.map(r => `${r.name ?? r.uri}: ${r.uri}`).join('\n');
        return { content: [{ type: 'text', text: summary }] };
    }
);
```

## Shutdown

For stateful multi-session HTTP servers, capture the `http.Server` from `app.listen()` so you can stop accepting connections, then close each session transport:

```ts source="../examples/guides/serverGuide.examples.ts#shutdown_statefulHttp"
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

```ts source="../examples/guides/serverGuide.examples.ts#shutdown_stdio"
process.on('SIGINT', async () => {
    await server.close();
    process.exit(0);
});
```

For a complete multi-session server with shutdown handling, see [`repl/server.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/repl/server.ts).

## Deployment

### DNS rebinding protection

Under normal circumstances, cross-origin browser restrictions limit what a malicious website can do to your localhost server. [DNS rebinding attacks](https://en.wikipedia.org/wiki/DNS_rebinding) get around those restrictions entirely by making the requests appear as same-origin,
since the attacking domain resolves to localhost. Validating the host header on the server side protects against this scenario. **All localhost MCP servers should use DNS rebinding protection.**

The recommended approach is to use {@linkcode @modelcontextprotocol/express!express.createMcpExpressApp | createMcpExpressApp()} (from `@modelcontextprotocol/express`) or {@linkcode @modelcontextprotocol/hono!hono.createMcpHonoApp | createMcpHonoApp()} (from
`@modelcontextprotocol/hono`), which enable Host header validation by default:

```ts source="../examples/guides/serverGuide.examples.ts#dnsRebinding_basic"
// Default: DNS rebinding protection auto-enabled (host is 127.0.0.1)
const app = createMcpExpressApp();

// DNS rebinding protection also auto-enabled for localhost
const appLocal = createMcpExpressApp({ host: 'localhost' });

// No automatic protection when binding to all interfaces
const appOpen = createMcpExpressApp({ host: '0.0.0.0' });
```

When binding to `0.0.0.0` / `::`, provide an allow-list of hosts:

```ts source="../examples/guides/serverGuide.examples.ts#dnsRebinding_allowedHosts"
const app = createMcpExpressApp({
    host: '0.0.0.0',
    allowedHosts: ['localhost', '127.0.0.1', 'myhost.local']
});
```

`createMcpHonoApp()` from `@modelcontextprotocol/hono` provides the same protection for Hono-based servers and Web Standard runtimes (Cloudflare Workers, Deno, Bun).

The app factories also validate the `Origin` header with the same arming rules: localhost-class binds are protected by default, and an explicit `allowedOrigins` list (hostnames, port-agnostic — the same convention as `allowedHosts`) replaces the default localhost allowlist; there
is no option that disables Origin validation for a localhost-class bind. Requests without an `Origin` header always pass, so MCP clients outside a browser are unaffected; a present `Origin` that is not allowed, or that cannot be parsed, is rejected with `403`. The per-framework
middleware (`originValidation`, `localhostOriginValidation`) can also be mounted explicitly, and `@modelcontextprotocol/node` ships equivalent request guards for plain `node:http` servers.

If you use `NodeStreamableHTTPServerTransport` directly with your own HTTP framework, you must implement Host header validation yourself. See the [`hostHeaderValidation`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/middleware/express/src/express.ts)
middleware source for reference. When mounting a handler bare on a fetch-native runtime, the framework-agnostic helpers from `@modelcontextprotocol/server` (`hostHeaderValidationResponse`, `originValidationResponse`) cover the same checks before the request reaches the handler.

## See also

- [`examples/`](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/examples) — Full runnable server examples
- [Client guide](./client.md) — Building MCP clients with this SDK
- [MCP overview](https://modelcontextprotocol.io/docs/learn/architecture) — Protocol-level concepts: participants, layers, primitives
- [Migration guide](./migration.md) — Upgrading from previous SDK versions
- [FAQ](./faq.md) — Frequently asked questions and troubleshooting

### Additional examples

| Feature                | Description                                                     | Example                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Web Standard transport | Deploy on Cloudflare Workers, Deno, or Bun                      | [`hono/server.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/hono/server.ts)                               |
| Session management     | Per-session transport routing, initialization, and cleanup      | [`legacy-routing/server.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/legacy-routing/server.ts)           |
| Resumability           | Replay missed SSE events via an event store                     | [`inMemoryEventStore.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/shared/src/inMemoryEventStore.ts)      |
| CORS                   | Expose MCP headers for browser clients                          | [`legacy-routing/server.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/legacy-routing/server.ts)           |
| Multi-node deployment  | Stateless, persistent-storage, and distributed routing patterns | [`examples/README.md`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/README.md#multi-node-deployment-patterns) |
