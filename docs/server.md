## Server overview

This SDK lets you build MCP servers in TypeScript and connect them to different transports. For most use cases you will use `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js` and choose one of:

- **Streamable HTTP** (recommended for remote servers)
- **HTTP + SSE** (deprecated, for backwards compatibility only)
- **stdio** (for local, process‑spawned integrations)

For a complete, runnable example server, see:

- [`simpleStreamableHttp.ts`](../src/examples/server/simpleStreamableHttp.ts) – feature‑rich Streamable HTTP server
- [`jsonResponseStreamableHttp.ts`](../src/examples/server/jsonResponseStreamableHttp.ts) – Streamable HTTP with JSON response mode
- [`simpleStatelessStreamableHttp.ts`](../src/examples/server/simpleStatelessStreamableHttp.ts) – stateless Streamable HTTP server
- [`simpleSseServer.ts`](../src/examples/server/simpleSseServer.ts) – deprecated HTTP+SSE transport
- [`sseAndStreamableHttpCompatibleServer.ts`](../src/examples/server/sseAndStreamableHttpCompatibleServer.ts) – backwards‑compatible server for old and new clients

## Transports

### Streamable HTTP

Streamable HTTP is the modern, fully featured transport. It supports:

- Request/response over HTTP POST
- Server‑to‑client notifications over SSE (when enabled)
- Optional JSON‑only response mode with no SSE
- Session management and resumability

Key examples:

- [`simpleStreamableHttp.ts`](../src/examples/server/simpleStreamableHttp.ts) – sessions, logging, tasks, elicitation, auth hooks
- [`jsonResponseStreamableHttp.ts`](../src/examples/server/jsonResponseStreamableHttp.ts) – `enableJsonResponse: true`, no SSE
- [`standaloneSseWithGetStreamableHttp.ts`](../src/examples/server/standaloneSseWithGetStreamableHttp.ts) – notifications with Streamable HTTP GET + SSE

See the MCP spec for full transport details: `https://modelcontextprotocol.io/specification/2025-11-25/basic/transports`

### Stateless vs stateful sessions

Streamable HTTP can run:

- **Stateless** – no session tracking, ideal for simple API‑style servers.
- **Stateful** – sessions have IDs, and you can enable resumability and advanced features.

Examples:

- Stateless Streamable HTTP: [`simpleStatelessStreamableHttp.ts`](../src/examples/server/simpleStatelessStreamableHttp.ts)
- Stateful with resumability: [`simpleStreamableHttp.ts`](../src/examples/server/simpleStreamableHttp.ts)

### stdio

For local integrations where the client spawns the server as a child process, use `StdioServerTransport`. Communication happens over stdin/stdout using JSON-RPC:

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'my-server', version: '1.0.0' });
// ... register tools, resources, prompts ...

const transport = new StdioServerTransport();
await server.connect(transport);
```

This is the simplest transport — no HTTP server setup required. The client uses `StdioClientTransport` to spawn and communicate with the server process (see [docs/client.md](client.md#stdio-transport)).

### Deprecated HTTP + SSE

The older HTTP+SSE transport (protocol version 2024‑11‑05) is supported only for backwards compatibility. New implementations should prefer Streamable HTTP.

Examples:

- Legacy SSE server: [`simpleSseServer.ts`](../src/examples/server/simpleSseServer.ts)
- Backwards‑compatible server (Streamable HTTP + SSE):  
  [`sseAndStreamableHttpCompatibleServer.ts`](../src/examples/server/sseAndStreamableHttpCompatibleServer.ts)

## Running your server

For a minimal “getting started” experience:

1. Start from [`simpleStreamableHttp.ts`](../src/examples/server/simpleStreamableHttp.ts).
2. Remove features you do not need (tasks, advanced logging, OAuth, etc.).
3. Register your own tools, resources and prompts.

For more detailed patterns (stateless vs stateful, JSON response mode, CORS, DNS rebind protection), see the examples above and the MCP spec sections on transports.

## DNS rebinding protection

MCP servers running on localhost are vulnerable to DNS rebinding attacks. Use `createMcpExpressApp()` to create an Express app with DNS rebinding protection enabled by default:

```typescript
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';

// Protection auto-enabled (default host is 127.0.0.1)
const app = createMcpExpressApp();

// Protection auto-enabled for localhost
const app = createMcpExpressApp({ host: 'localhost' });

// No auto protection when binding to all interfaces
const app = createMcpExpressApp({ host: '0.0.0.0' });
```

For custom host validation, use the middleware directly:

```typescript
import express from 'express';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';

const app = express();
app.use(express.json());
app.use(hostHeaderValidation(['localhost', '127.0.0.1', 'myhost.local']));
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

- [`simpleStreamableHttp.ts`](../src/examples/server/simpleStreamableHttp.ts)
- [`toolWithSampleServer.ts`](../src/examples/server/toolWithSampleServer.ts)

#### Image and audio results

Tools can return image and audio content alongside text. Use base64-encoded data with the appropriate MIME type:

```typescript
// e.g. const chartPngBase64 = fs.readFileSync('chart.png').toString('base64');
server.registerTool('generate-chart', { description: 'Generate a chart image' }, async () => ({
    content: [
        {
            type: 'image',
            data: chartPngBase64,
            mimeType: 'image/png'
        }
    ]
}));

// e.g. const audioBase64 = fs.readFileSync('speech.wav').toString('base64');
server.registerTool(
    'text-to-speech',
    {
        description: 'Convert text to speech',
        inputSchema: { text: z.string() }
    },
    async ({ text }) => ({
        content: [
            {
                type: 'audio',
                data: audioBase64,
                mimeType: 'audio/wav'
            }
        ]
    })
);
```

#### Embedded resource results

Tools can return embedded resources, allowing the tool to attach full resource objects in its response:

```typescript
server.registerTool('fetch-data', { description: 'Fetch and return data as a resource' }, async () => ({
    content: [
        {
            type: 'resource',
            resource: {
                uri: 'data://result',
                mimeType: 'application/json',
                text: JSON.stringify({ key: 'value' })
            }
        }
    ]
}));
```

#### Error handling

To indicate that a tool call failed, set `isError: true` in the result. The content describes what went wrong:

```typescript
server.registerTool('risky-operation', { description: 'An operation that might fail' }, async () => {
    try {
        const result = await doSomething();
        return { content: [{ type: 'text', text: result }] };
    } catch (err) {
        return {
            content: [{ type: 'text', text: `Error: ${err.message}` }],
            isError: true
        };
    }
});
```

#### Tool change notifications

When tools are added, removed, or updated at runtime, the server automatically notifies connected clients. This happens when you call `registerTool()`, or use `remove()`, `enable()`, `disable()`, or `update()` on a `RegisteredTool`. You can also trigger it manually:

```typescript
server.sendToolListChanged();
```

#### ResourceLink outputs

Tools can return `resource_link` content items to reference large resources without embedding them directly, allowing clients to fetch only what they need.

The README's `list-files` example shows the pattern conceptually; for concrete usage, see the Streamable HTTP examples in `src/examples/server`.

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

#### Binary resources

Resources can return binary data using `blob` (base64-encoded) instead of `text`:

```typescript
server.registerResource('logo', 'images://logo.png', { title: 'Logo', mimeType: 'image/png' }, async uri => ({
    contents: [{ uri: uri.href, blob: logoPngBase64 }]
}));
```

#### Resource templates

Dynamic resources use `ResourceTemplate` to match URI patterns. The template parameters are passed to the read callback:

```typescript
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';

server.registerResource('user-profile', new ResourceTemplate('users://{userId}/profile', { list: undefined }), { title: 'User Profile', mimeType: 'application/json' }, async (uri, { userId }) => ({
    contents: [
        {
            uri: uri.href,
            text: JSON.stringify(await getUser(userId))
        }
    ]
}));
```

#### Subscribing and unsubscribing

Clients can subscribe to resource changes. The server declares subscription support via the `resources.subscribe` capability, which `McpServer` enables automatically when resources are registered.

To handle subscriptions, register handlers on the low-level server for `SubscribeRequestSchema` and `UnsubscribeRequestSchema`:

```typescript
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const subscriptions = new Set<string>();

server.server.setRequestHandler(SubscribeRequestSchema, async request => {
    subscriptions.add(request.params.uri);
    return {};
});

server.server.setRequestHandler(UnsubscribeRequestSchema, async request => {
    subscriptions.delete(request.params.uri);
    return {};
});
```

When a subscribed resource changes, notify the client:

```typescript
if (subscriptions.has(resourceUri)) {
    await server.server.sendResourceUpdated({ uri: resourceUri });
}
```

Resource list changes (adding/removing resources) are notified automatically when using `registerResource()`, `remove()`, `enable()`, or `disable()`. You can also trigger it manually:

```typescript
server.sendResourceListChanged();
```

For full runnable examples of resources:

- [`simpleStreamableHttp.ts`](../src/examples/server/simpleStreamableHttp.ts)

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

#### Image content in prompts

Prompts can include image content in their messages:

```typescript
server.registerPrompt(
    'analyze-image',
    {
        title: 'Analyze Image',
        description: 'Analyze an image',
        argsSchema: { imageBase64: z.string() }
    },
    ({ imageBase64 }) => ({
        messages: [
            {
                role: 'user',
                content: {
                    type: 'image',
                    data: imageBase64,
                    mimeType: 'image/png'
                }
            }
        ]
    })
);
```

#### Embedded resources in prompts

Prompts can embed resource content in their messages:

```typescript
server.registerPrompt(
    'summarize-doc',
    {
        title: 'Summarize Document',
        description: 'Summarize a document resource'
    },
    () => ({
        messages: [
            {
                role: 'user',
                content: {
                    type: 'resource',
                    resource: {
                        uri: 'docs://readme',
                        mimeType: 'text/plain',
                        text: 'Document content here...'
                    }
                }
            }
        ]
    })
);
```

#### Prompt change notifications

Like tools, prompt list changes are notified automatically when using `registerPrompt()`, `remove()`, `enable()`, or `disable()`. You can also trigger it manually:

```typescript
server.sendPromptListChanged();
```

For prompts integrated into a full server, see:

- [`simpleStreamableHttp.ts`](../src/examples/server/simpleStreamableHttp.ts)

### Completions

Both prompts and resources can support argument completions using the `completable` wrapper. This lets clients offer autocomplete suggestions as users type.

```typescript
import { completable } from '@modelcontextprotocol/sdk/server/completable.js';

server.registerPrompt(
    'greet',
    {
        title: 'Greeting',
        description: 'Generate a greeting',
        argsSchema: {
            name: completable(z.string(), value => {
                // Return suggestions matching the partial input
                const names = ['Alice', 'Bob', 'Charlie'];
                return names.filter(n => n.toLowerCase().startsWith(value.toLowerCase()));
            })
        }
    },
    ({ name }) => ({
        messages: [{ role: 'user', content: { type: 'text', text: `Hello, ${name}!` } }]
    })
);
```

Resource templates also support completions on their path parameters via `completable`. On the client side, use `client.complete()` with a reference to the prompt or resource and the partially-typed argument:

```typescript
const result = await client.complete({
    ref: { type: 'ref/prompt', name: 'greet' },
    argument: { name: 'name', value: 'Al' }
});
console.log(result.completion.values); // ['Alice']
```

### Logging

The server can send log messages to the client using `server.sendLoggingMessage()`. Clients can request a minimum log level via the `logging/setLevel` request, which `McpServer` handles automatically — messages below the requested level are suppressed.

```typescript
// Send a log message from a tool handler:
server.registerTool(
    'process-data',
    {
        description: 'Process some data',
        inputSchema: { data: z.string() }
    },
    async ({ data }, extra) => {
        await server.sendLoggingMessage({ level: 'info', data: `Processing: ${data}` }, extra.sessionId);
        // ... do work ...
        return { content: [{ type: 'text', text: 'Done' }] };
    }
);
```

For a full example, see [`simpleStreamableHttp.ts`](../src/examples/server/simpleStreamableHttp.ts) which uses `sendLoggingMessage` throughout.

Log levels in order: `debug`, `info`, `notice`, `warning`, `error`, `critical`, `alert`, `emergency`.

#### Log level filtering

Clients can request a minimum log level via `logging/setLevel`. The low-level `Server` handles this automatically when the `logging` capability is enabled — it stores the requested level per session and suppresses messages below it. You can also send log messages directly using
`sendLoggingMessage`:

```typescript
const server = new McpServer({ name: 'my-server', version: '1.0.0' }, { capabilities: { logging: {} } });

// Client requests: only show 'warning' and above
// (handled automatically by the Server)

// These will be sent or suppressed based on the client's requested level:
await server.sendLoggingMessage({ level: 'debug', data: 'verbose detail' }); // suppressed
await server.sendLoggingMessage({ level: 'warning', data: 'something is off' }); // sent
await server.sendLoggingMessage({ level: 'error', data: 'something broke' }); // sent
```

### Display names and metadata

Tools, resources and prompts support a `title` field for human‑readable names. Older APIs can also attach `annotations.title`. To compute the correct display name on the client, use:

- `getDisplayName` from `@modelcontextprotocol/sdk/shared/metadataUtils.js`

## Multi‑node deployment patterns

The SDK supports multi‑node deployments using Streamable HTTP. The high‑level patterns are documented in [`README.md`](../src/examples/README.md):

- Stateless mode (any node can handle any request)
- Persistent storage mode (shared database for session state)
- Local state with message routing (message queue + pub/sub)

Those deployment diagrams are kept in [`README.md`](../src/examples/README.md) so the examples and documentation stay aligned.

## Backwards compatibility

To handle both modern and legacy clients:

- Run a backwards‑compatible server:
    - [`sseAndStreamableHttpCompatibleServer.ts`](../src/examples/server/sseAndStreamableHttpCompatibleServer.ts)
- Use a client that falls back from Streamable HTTP to SSE:
    - [`streamableHttpWithSseFallbackClient.ts`](../src/examples/client/streamableHttpWithSseFallbackClient.ts)

For the detailed protocol rules, see the “Backwards compatibility” section of the MCP spec.
