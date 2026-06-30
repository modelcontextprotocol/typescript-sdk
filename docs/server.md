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
import { createServer } from 'node:http';

import type { OAuthTokenVerifier } from '@modelcontextprotocol/express';
import {
    createMcpExpressApp,
    getOAuthProtectedResourceMetadataUrl,
    mcpAuthMetadataRouter,
    requireBearerAuth
} from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport, toNodeHandler } from '@modelcontextprotocol/node';
import type { CallToolResult, InputRequiredResult, OAuthMetadata, ResourceLink } from '@modelcontextprotocol/server';
import {
    acceptedContent,
    completable,
    createMcpHandler,
    createRequestStateCodec,
    inputRequired,
    McpServer,
    ResourceTemplate,
    TRACEPARENT_META_KEY
} from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
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

#### Serving the 2026-07-28 draft revision over HTTP

A hand-wired Streamable HTTP transport speaks the 2025-era protocol it was written for. To serve the 2026-07-28 draft revision, use `createMcpHandler`: it builds one instance from your factory per request and, by default, serves 2025-era traffic stateless from the same factory:

```ts source="../examples/guides/serverGuide.examples.ts#createMcpHandler_basic"
const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'my-server', version: '1.0.0' }, { capabilities: { tools: {} } });
    // register tools/resources/prompts once; the same factory serves both eras
    return server;
});
```

`handler.fetch` is a web-standard `(Request) => Promise<Response>`: on Cloudflare Workers, Deno, or Bun, `export default handler` is all the mounting you need. For Express, Fastify, or plain `node:http`, wrap the handler once with `toNodeHandler` from
`@modelcontextprotocol/node`:

```ts source="../examples/guides/serverGuide.examples.ts#createMcpHandler_node"
createServer(toNodeHandler(handler)).listen(3000);
// Express: app.all('/mcp', toNodeHandler(handler));
// behind express.json(): const node = toNodeHandler(handler); app.all('/mcp', (req, res) => void node(req, res, req.body));
```

**Options:** Pass `legacy: 'reject'` to refuse 2025-era requests with the unsupported-protocol-version error (the default, `'stateless'`, serves them per request with no sessions). `onerror` observes out-of-band errors without altering responses. The entry performs no
Origin/Host validation and no token verification itself. Mount [DNS rebinding protection](#dns-rebinding-protection) in front of it, and pass validated auth through `handler.fetch(request, { authInfo })` (or `req.auth` when using `toNodeHandler`).

To keep an existing sessionful 2025 deployment serving legacy traffic, route with `isLegacyRequest` in front of a strict (`legacy: 'reject'`) handler. See the [2026-07-28 support guide](./migration/support-2026-07-28.md) for the migration patterns; a runnable dual-transport example lives at [`dual-era/server.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/dual-era/server.ts).

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

```ts source="../examples/guides/serverGuide.examples.ts#serveStdio_basic"
serveStdio(() => {
    const server = new McpServer({ name: 'my-server', version: '1.0.0' }, { capabilities: { tools: {} } });
    // register tools/resources/prompts once; the same factory serves both eras
    return server;
});
```

Plain 2025 clients open with `initialize` and are served exactly as before; 2026-capable clients negotiate via `server/discover` and send each request with the per-request `_meta` envelope, and their connection is pinned to a 2026-era instance. On 2026-pinned connections, read per-request client identity from `ctx.mcpReq.envelope` in your handlers rather than the connection-scoped accessors (see the [2026-07-28 support guide](./migration/support-2026-07-28.md) for details). A runnable
example lives at `examples/dual-era/server.ts`, with a two-legged client at `examples/dual-era/client.ts`.

**Options:** `legacy: 'reject'` refuses 2025-era openings with the unsupported-protocol-version error (default `'serve'`). `transport` brings your own `Transport` (for example a `StdioServerTransport` constructed over a socket), and the entry owns it either way. `onerror`
observes out-of-band errors. The returned handle's `close()` tears down the pinned instance and the transport. During era selection the entry may construct and discard a probe instance, so keep factories cheap and side-effect-free.

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

Register a tool with {@linkcode @modelcontextprotocol/server!server/mcp.McpServer#registerTool | registerTool}. Provide an `inputSchema` (any Standard Schema library that supports JSON Schema conversion: Zod v4 shown here; ArkType and Valibot also conform) to validate
arguments, and optionally an `outputSchema` for structured return values.

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

To notify clients when a resource's content changes, see [Change notifications](#change-notifications).

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

For resource templates, pass a `complete` callback map to the `ResourceTemplate` constructor instead.

## Extension capabilities

A server advertises support for [MCP extensions](https://modelcontextprotocol.io/specification/latest/basic/lifecycle#capability-negotiation) through `capabilities.extensions` — a map from extension identifier to that extension's settings object. Declare entries with
{@linkcode @modelcontextprotocol/server!server/server.Server#registerCapabilities | server.server.registerCapabilities()} before connecting:

```ts source="../examples/guides/serverGuide.examples.ts#extensionCapabilities_register"
server.server.registerCapabilities({
    extensions: { 'com.example/feature-flags': { flags: ['dark-mode', 'beta-search'] } }
});
```

The map is advertised in the `initialize` result on legacy connections and in the `server/discover` response on 2026-07-28 ones. Identifiers are prefix-qualified per the spec's `_meta` key naming rules (e.g. `com.example/feature-flags`); each value is free-form JSON for
that extension's settings — `{}` means supported with no settings.

For a runnable pair, see the [`extension-capabilities/` example](../examples/extension-capabilities/README.md); reading the map client-side is covered in the [client guide](./client.md#extension-capabilities).

## Cache hints (2026-07-28 draft)

The 2026-07-28 revision requires `ttlMs` and `cacheScope` on the cacheable results (`tools/list`, `prompts/list`, `resources/list`, `resources/templates/list`, `resources/read`, and `server/discover`) so clients and intermediaries know how long a response stays fresh and
whether it may be shared (SEP-2549). The SDK fills both fields automatically when serving that revision, defaulting to `ttlMs: 0` and `cacheScope: 'private'` (immediately stale, never shared). Responses to 2025-era requests are never affected.

To advertise a real cache policy, set {@linkcode @modelcontextprotocol/server!server/server.ServerOptions | ServerOptions.cacheHints} per operation, and/or `cacheHint` on an individual resource registration:

```ts source="../examples/guides/serverGuide.examples.ts#cacheHints_basic"
const server = new McpServer(
    { name: 'my-server', version: '1.0.0' },
    {
        cacheHints: {
            // The tool list is the same for every caller and rarely changes:
            'tools/list': { ttlMs: 60_000, cacheScope: 'public' }
        }
    }
);

server.registerResource(
    'config',
    'config://app',
    {
        mimeType: 'text/plain',
        // Wins field-by-field over a cacheHints['resources/read'] entry;
        // cacheScope stays at the 'private' default here.
        cacheHint: { ttlMs: 300_000 }
    },
    async uri => ({
        contents: [{ uri: uri.href, text: 'App configuration here' }]
    })
);
```

Resolution is per field, most specific author first: values set directly on the handler's result, then the resource's `cacheHint`, then the matching `cacheHints` entry, then the defaults.
Invalid hint values throw a `RangeError` at construction/registration time, and the `cacheHint` key is stripped from the resource's listed metadata (it configures the read result, not the listing).

Use `cacheScope: 'public'` only for results that are identical for every caller: a `'public'` result may be served to other users by shared caches. Anything derived from the request's authorization context must stay `'private'` (the default).

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

On a 2026-07-28 request, `ctx.mcpReq.log()` reads its level filter from the request's `io.modelcontextprotocol/logLevel` `_meta` key. When the client did not set one, the call is a silent no-op (the spec forbids sending `notifications/message` without the opt-in). On
2025-era connections the session level set via `logging/setLevel` applies as before. See [2026-07-28 support guide › per-request `logLevel`](./migration/support-2026-07-28.md#ctxmcpreqlog-and-the-per-request-loglevel).

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

## Change notifications

Servers can signal that their tool, prompt, or resource lists changed, or that a specific resource's content changed, so clients can refresh.

**List changes** are emitted automatically: registering, enabling, disabling, updating, or removing a tool, prompt, or resource sends the matching `notifications/*/list_changed` (`McpServer` advertises the corresponding `listChanged: true` capability on registration;
declare it up front only when using the low-level `Server`). You can also send them explicitly with {@linkcode @modelcontextprotocol/server!server/mcp.McpServer#sendToolListChanged | sendToolListChanged()}, `sendPromptListChanged()`, and `sendResourceListChanged()`.

**Per-resource updates** (2025-era connections) require hand-wiring; `registerResource` has no subscribe option. Declare `resources: { subscribe: true }`, register the `resources/subscribe`/`resources/unsubscribe` handlers on the underlying low-level server, and push
{@linkcode @modelcontextprotocol/server!server/server.Server#sendResourceUpdated | sendResourceUpdated()} when the data changes:

```ts source="../examples/guides/serverGuide.examples.ts#subscriptions_legacy"
const server = new McpServer(
    { name: 'my-server', version: '1.0.0' },
    { capabilities: { resources: { subscribe: true, listChanged: true } } }
);

const subscriptions = new Set<string>();
server.server.setRequestHandler('resources/subscribe', async request => {
    subscriptions.add(request.params.uri);
    return {};
});
server.server.setRequestHandler('resources/unsubscribe', async request => {
    subscriptions.delete(request.params.uri);
    return {};
});

// When the underlying data changes:
async function onConfigChanged() {
    if (subscriptions.has('config://app')) {
        await server.server.sendResourceUpdated({ uri: 'config://app' });
    }
}
```

**On the 2026-07-28 revision** clients receive change notifications only on a `subscriptions/listen` stream they open, and the serving entries handle that method themselves (nothing to register). Over HTTP, publish through the handler's typed
{@linkcode @modelcontextprotocol/server!server/serverEventBus.ServerNotifier | notify} facade; each call reaches every open subscription that opted in:

```ts source="../examples/guides/serverGuide.examples.ts#subscriptions_notify"
const handler = createMcpHandler(() => buildServer());

// When the underlying data changes:
handler.notify.resourceUpdated('config://app');
handler.notify.toolsChanged();
```

The default in-process {@linkcode @modelcontextprotocol/server!server/serverEventBus.InMemoryServerEventBus | InMemoryServerEventBus} covers single-process deployments; multi-process deployments supply their own
{@linkcode @modelcontextprotocol/server!server/serverEventBus.ServerEventBus | ServerEventBus} via the `bus` option. On stdio, `serveStdio` pins one instance per connection and routes its ordinary `send*ListChanged()` calls onto open subscriptions automatically. Per-resource updates need one change on a 2026 connection: the subscription bookkeeping lives at the entry (the client's listen filter), so the hand-wired `resources/subscribe` handlers above never run. Publish
`sendResourceUpdated()` unconditionally when the data changes and let the entry deliver it only to subscriptions that listed the URI.

On the 2026-07-28 revision delivery is capability-gated per type: the entry honors `resourceSubscriptions` only when the server advertises `resources: { subscribe: true }`, and each list-changed type only with the matching `listChanged` capability (on 2025-era connections
the SDK gates sends on the presence of the corresponding capability). Clients subscribe to exact resource URIs.

See [`subscriptions/server.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/subscriptions/server.ts) for a runnable dual-transport example, and the
[2026-07-28 support guide › `subscriptions/listen`](./migration/support-2026-07-28.md#subscriptionslisten) for migration-level detail.

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

MCP is bidirectional: servers can request input _from_ the client during tool execution, as long as the client declares matching capabilities (see [Architecture](https://modelcontextprotocol.io/docs/learn/architecture) in the MCP overview). On 2025-era connections the server pushes a JSON-RPC request to the client (the sections below). On the 2026-07-28 revision there is no server→client request channel: the handler **returns** an `input_required` result carrying the embedded requests,
and the client retries the call with the responses.

On a connection pinned to the 2026-07-28 draft revision (served via `serveStdio` or `createMcpHandler`), the push-style channels below throw an {@linkcode @modelcontextprotocol/server!index.SdkError | SdkError} with
code {@linkcode @modelcontextprotocol/server!index.SdkErrorCode.MethodNotSupportedByProtocolVersion | METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION} before anything reaches the wire (see the [2026-07-28 support guide](./migration/support-2026-07-28.md)).

### Requesting input on 2026-07-28: `input_required`

On the 2026-07-28 revision a `tools/call`, `prompts/get`, or `resources/read` handler requests client input by returning {@linkcode @modelcontextprotocol/server!index.inputRequired | inputRequired(...)}. The result names one or more
embedded requests, built with `inputRequired.elicit(...)` (form elicitation), `inputRequired.elicitUrl(...)` (URL elicitation), `inputRequired.createMessage(...)` (sampling), or `inputRequired.listRoots()`. Write the handler **write-once**: on every entry, first read what has already arrived via {@linkcode @modelcontextprotocol/server!index.acceptedContent | acceptedContent(ctx.mcpReq.inputResponses, key)}, and only ask for what is still missing:

```ts source="../examples/guides/serverGuide.examples.ts#registerTool_inputRequired"
server.registerTool(
    'deploy',
    {
        description: 'Deploy after user confirmation',
        inputSchema: z.object({ env: z.string() })
    },
    async ({ env }, ctx): Promise<CallToolResult | InputRequiredResult> => {
        const confirmed = acceptedContent<{ confirm: boolean }>(ctx.mcpReq.inputResponses, 'confirm');
        if (confirmed?.confirm !== true) {
            return inputRequired({
                inputRequests: {
                    confirm: inputRequired.elicit({
                        message: `Deploy to ${env}?`,
                        requestedSchema: {
                            type: 'object',
                            properties: { confirm: { type: 'boolean' } },
                            required: ['confirm']
                        }
                    })
                }
            });
        }
        return { content: [{ type: 'text', text: `Deployed to ${env}` }] };
    }
);
```

Every `input_required` result must carry at least one of `inputRequests` or `requestState`: the builder throws a `TypeError` otherwise, and the seam re-checks the rule for hand-built results. Each embedded request is checked against the capabilities the client declared on
the request's `_meta` envelope; a missing capability rejects the call with `-32021` before anything reaches the wire. The responses in `ctx.mcpReq.inputResponses` come from the client; treat them as untrusted input.

On 2025-era connections you don't need to branch: the SDK's legacy shim (on by default) fulfils `input_required` returns by issuing real elicitation/sampling/roots requests over the session, so handlers stay write-once. Knobs and limits are described in [the legacy shim section of the 2026-07-28 support guide](./migration/support-2026-07-28.md#legacy-shim-for-input_required).

For the full multi-step pattern (confirmation, then URL-mode sign-in), see [`mrtr/server.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/mrtr/server.ts).

#### Carrying state across rounds: `requestState`

The 2026-07-28 serving entries are per-request: nothing survives between rounds on the server. To remember where a multi-step flow stands, return an opaque `requestState` string alongside (or instead of) `inputRequests`; the client echoes it back byte-for-byte on the retry
and the handler reads it back with the typed `ctx.mcpReq.requestState<State>()` accessor.

> [!IMPORTANT]
> `requestState` round-trips through the client and comes back as **attacker-controlled input**. State that influences authorization, resource access, or business logic must be integrity-protected; the SDK applies no protection of its own. Use
> {@linkcode @modelcontextprotocol/server!index.createRequestStateCodec | createRequestStateCodec}, an HMAC-SHA256 codec whose `verify` drops directly into the `ServerOptions.requestState` hook, which runs before the handler and answers tampered or expired state with a
> wire-level `-32602` (frozen message `"Invalid or expired requestState"`). The codec is signed, not encrypted. Do not put secrets in the payload.

```ts source="../examples/guides/serverGuide.examples.ts#requestState_codec"
const stateCodec = createRequestStateCodec<{ step: string }>({
    key: crypto.getRandomValues(new Uint8Array(32)), // >= 32 bytes; share across instances in a fleet
    ttlSeconds: 600
});

const server = new McpServer(
    { name: 'my-server', version: '1.0.0' },
    { capabilities: { tools: {} }, requestState: { verify: stateCodec.verify } }
);
```

Inside a handler, mint state on the way out and read it back on re-entry. The `requestState.verify` hook has already run by then, and the accessor returns its decoded payload (or the raw string when no hook is configured):

```ts source="../examples/guides/serverGuide.examples.ts#requestState_mintDecode"
server.registerTool(
    'wipe-cache',
    { description: 'Confirm, then pick a scope, then wipe', inputSchema: z.object({}) },
    async (_args, ctx): Promise<CallToolResult | InputRequiredResult> => {
        const state = ctx.mcpReq.requestState<{ step: string }>();

        if (state?.step !== 'confirmed') {
            const confirmed = acceptedContent<{ confirm: boolean }>(ctx.mcpReq.inputResponses, 'confirm');
            if (confirmed?.confirm !== true) {
                return inputRequired({
                    inputRequests: {
                        confirm: inputRequired.elicit({
                            message: 'Really wipe the cache?',
                            requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] }
                        })
                    }
                });
            }
            // Mint only what the response above already proved: the user confirmed.
            return inputRequired({
                inputRequests: {
                    scope: inputRequired.elicit({
                        message: 'Which scope?',
                        requestedSchema: { type: 'object', properties: { scope: { type: 'string' } }, required: ['scope'] }
                    })
                },
                requestState: await stateCodec.mint({ step: 'confirmed' })
            });
        }

        const scope = acceptedContent<{ scope: string }>(ctx.mcpReq.inputResponses, 'scope');
        return { content: [{ type: 'text', text: `Wiped ${scope?.scope ?? 'all'}` }] };
    }
);
```

Mint state that records what earlier rounds already proved, never an outcome that has not happened yet. The codec makes the token tamper-proof, which means it is bearer proof of whatever you put in it: a token minted as `{ step: 'signed-in' }` before the user signs in grants that step to anyone who echoes it.

See [`mrtr/server.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/mrtr/server.ts) for the worked end-to-end flow, and the
[2026-07-28 support guide › Replacing per-session state](./migration/support-2026-07-28.md#replacing-per-session-state-requeststate) for porting session-keyed code.

### Sampling

> [!WARNING]
> Sampling is deprecated as of protocol version 2026-07-28 (SEP-2577). It remains fully functional on 2025-era connections during the deprecation window (at least twelve months); see the [deprecated features registry](https://modelcontextprotocol.io/specification/draft/deprecated). Migrate to
> calling LLM provider APIs directly from your server.

> [!NOTE]
> `ctx.mcpReq.requestSampling` is the 2025-era push channel and **throws a typed error on a 2026-07-28-era request**. On that revision, return `inputRequired({ inputRequests: { id: inputRequired.createMessage({ … }) } })` instead; see
> [Requesting input on 2026-07-28](#requesting-input-on-2026-07-28-input_required).

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

> [!NOTE]
> `ctx.mcpReq.elicitInput` is the 2025-era push channel and **throws a typed error on a 2026-07-28-era request**. Return `inputRequired.elicit(...)` (form) or `inputRequired.elicitUrl(...)` (URL) via `inputRequired({ inputRequests: { … } })` instead; see
> [Requesting input on 2026-07-28](#requesting-input-on-2026-07-28-input_required). The throw-style `UrlElicitationRequiredError` (`-32042`) also fails loudly toward 2026-era requests.

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
> Roots are deprecated as of protocol version 2026-07-28 (SEP-2577). They remain fully functional on 2025-era connections during the deprecation window (at least twelve months); see the [deprecated features registry](https://modelcontextprotocol.io/specification/draft/deprecated). Migrate to
> passing paths via tool parameters, resource URIs, or configuration.

> [!NOTE]
> `server.server.listRoots()` **throws a typed error on a 2026-07-28-era instance**. Return `inputRequired({ inputRequests: { roots: inputRequired.listRoots() } })` and read the response from `ctx.mcpReq.inputResponses` on re-entry; see
> [Requesting input on 2026-07-28](#requesting-input-on-2026-07-28-input_required).

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

If you use `NodeStreamableHTTPServerTransport` directly with your own HTTP framework, you must implement Host header validation yourself. See the [`hostHeaderValidation`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/middleware/express/src/middleware/hostHeaderValidation.ts)
middleware source for reference. When mounting a handler bare on a fetch-native runtime, the framework-agnostic helpers from `@modelcontextprotocol/server` (`hostHeaderValidationResponse`, `originValidationResponse`) cover the same checks before the request reaches the handler.

### Authorization (OAuth resource server)

HTTP servers can require OAuth bearer tokens (see [Authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization) in the MCP specification). The SDK treats your server as an OAuth _resource server_: it verifies tokens issued by an authorization
server; it does not issue them. Token verification, the `WWW-Authenticate` challenge, and the [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728) protected resource metadata document come from `@modelcontextprotocol/express`:

```ts source="../examples/guides/serverGuide.examples.ts#auth_resourceServer"
const mcpServerUrl = new URL('https://api.example.com/mcp');

// Verify tokens however your deployment requires: JWT verification,
// RFC 7662 introspection, a call to your IdP.
const verifier: OAuthTokenVerifier = {
    async verifyAccessToken(token) {
        const payload = await verifyJwt(token);
        return { token, clientId: payload.sub, scopes: payload.scopes, expiresAt: payload.exp };
    }
};

// Public deployment: allow-list the public host (see DNS rebinding protection).
const app = createMcpExpressApp({ host: '0.0.0.0', allowedHosts: ['api.example.com'] });

// Serves /.well-known/oauth-protected-resource/mcp (RFC 9728) and mirrors the
// authorization server's metadata, so clients can discover your AS.
app.use(mcpAuthMetadataRouter({ oauthMetadata, resourceServerUrl: mcpServerUrl }));

// 401/403 responses carry `WWW-Authenticate: Bearer …` with `resource_metadata`
// pointing at the document above. That challenge is what starts the client
// SDK's OAuth flow.
const auth = requireBearerAuth({
    verifier,
    requiredScopes: ['mcp'],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpServerUrl)
});

const node = toNodeHandler(createMcpHandler(buildServer));
app.all('/mcp', auth, (req, res) => void node(req, res, req.body));
```

`requireBearerAuth` attaches the verified `AuthInfo` to `req.auth`; `toNodeHandler` forwards it so tool handlers read it as `ctx.http.authInfo` (and `createMcpHandler` factories as `ctx.authInfo`). A missing or invalid token gets `401 invalid_token`, as does a token whose `expiresAt` is unset or in the past. A valid token missing one of `requiredScopes` gets `403 insufficient_scope`; the challenge's `scope` field is what clients use for scope step-up (SEP-2350).

Authorization Server helpers (`mcpAuthRouter`, `ProxyOAuthServerProvider`, …) live in `@modelcontextprotocol/server-legacy/auth` as a frozen v1 copy; new code should use a dedicated IdP or OAuth library for the AS (see the [FAQ](./faq.md#where-are-the-server-auth-helpers)).

For runnable examples, see [`bearer-auth/server.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/bearer-auth/server.ts) (minimal static verifier) and
[`oauth/server.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/oauth/server.ts) (full discovery flow against a demo authorization server).

## See also

- [`examples/`](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/examples) — Full runnable server examples
- [Client guide](./client.md) — Building MCP clients with this SDK
- [MCP overview](https://modelcontextprotocol.io/docs/learn/architecture) — Protocol-level concepts: participants, layers, primitives
- [Migration guide](./migration/index.md) — Upgrading from previous SDK versions
- [FAQ](./faq.md) — Frequently asked questions and troubleshooting

### Additional examples

| Feature                | Description                                                     | Example                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Web Standard transport | Deploy on Cloudflare Workers, Deno, or Bun                      | [`hono/server.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/hono/server.ts)                               |
| Session management     | Per-session transport routing, initialization, and cleanup      | [`legacy-routing/server.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/legacy-routing/server.ts)           |
| Resumability           | Replay missed SSE events via an event store                     | [`inMemoryEventStore.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/shared/src/inMemoryEventStore.ts)      |
| CORS                   | Expose MCP headers for browser clients                          | [`legacy-routing/server.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/legacy-routing/server.ts)           |
| Multi-node deployment  | Stateless, persistent-storage, and distributed routing patterns | [`examples/README.md`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/README.md#multi-node-deployment-patterns) |
| Dual-era serving       | One factory serving 2025 + 2026-07-28 over HTTP and stdio       | [`dual-era/server.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/dual-era/server.ts)                       |
| Change notifications   | Publish `subscriptions/listen` change events over HTTP and stdio | [`subscriptions/server.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/subscriptions/server.ts)            |
| OAuth resource server  | Bearer-token verification, `WWW-Authenticate` challenge, RFC 9728 metadata | [`bearer-auth/server.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/bearer-auth/server.ts), [`oauth/server.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/oauth/server.ts) |
