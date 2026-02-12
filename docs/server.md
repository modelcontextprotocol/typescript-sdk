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

#### Change notifications

When tools are added, removed, or updated at runtime, the server notifies connected clients so they can refresh their tool list. If you use `McpServer.registerTool()`, the notification is sent automatically. You can also trigger it manually:

```typescript
// Automatic: registerTool sends the notification for you
server.registerTool('new-tool', { description: 'Added at runtime' }, async () => ({
    content: [{ type: 'text', text: 'result' }]
}));

// Manual: trigger explicitly when tools change outside registerTool
server.sendToolListChanged();
```

On the client side, listen for the notification to re-fetch tools:

```typescript
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    const { tools } = await client.listTools();
    console.log('Tools updated:', tools.map(t => t.name));
});
```

#### ResourceLink outputs

Tools can return `resource_link` content items to reference large resources without embedding them directly, allowing clients to fetch only what they need.

The README’s `list-files` example shows the pattern conceptually; for concrete usage, see the Streamable HTTP examples in `src/examples/server`.

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

For prompts integrated into a full server, see:

- [`simpleStreamableHttp.ts`](../src/examples/server/simpleStreamableHttp.ts)

#### Embedded resources in prompts

Prompt messages can include embedded resources alongside text. Use the `resource` content type to attach file contents or other resource data directly in the prompt response:

```typescript
server.registerPrompt(
    'analyze-file',
    {
        description: 'Analyze a file with context',
        argsSchema: { filename: z.string() }
    },
    async ({ filename }) => ({
        messages: [
            {
                role: 'user',
                content: {
                    type: 'resource',
                    resource: {
                        uri: `file://${filename}`,
                        mimeType: 'text/plain',
                        text: 'File contents here'
                    }
                }
            },
            {
                role: 'user',
                content: { type: 'text', text: 'Please review the file above.' }
            }
        ]
    })
);
```

#### Image content in prompts

Prompts can return image content using the `image` content type with base64-encoded data:

```typescript
server.registerPrompt(
    'analyze-screenshot',
    { description: 'Analyze a screenshot' },
    async () => ({
        messages: [
            {
                role: 'user',
                content: {
                    type: 'image',
                    data: 'iVBORw0KGgoAAAANS...', // base64-encoded image
                    mimeType: 'image/png'
                }
            },
            {
                role: 'user',
                content: { type: 'text', text: 'Describe what you see in this image.' }
            }
        ]
    })
);
```

#### Change notifications

Like tools, prompt list changes are automatically notified when you use `registerPrompt()`. You can also trigger the notification manually:

```typescript
server.sendPromptListChanged();
```

On the client side:

```typescript
import { PromptListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
    const { prompts } = await client.listPrompts();
    console.log('Prompts updated:', prompts.map(p => p.name));
});
```

### Completions

Both prompts and resources can support argument completions. On the client side, you use `client.complete()` with a reference to the prompt or resource and the partially‑typed argument.

See the MCP spec sections on prompts and resources for complete details, and [`simpleStreamableHttp.ts`](../src/examples/client/simpleStreamableHttp.ts) for client‑side usage patterns.

### Display names and metadata

Tools, resources and prompts support a `title` field for human‑readable names. Older APIs can also attach `annotations.title`. To compute the correct display name on the client, use:

- `getDisplayName` from `@modelcontextprotocol/sdk/shared/metadataUtils.js`

## Logging

MCP servers can send log messages to connected clients, and clients can request a minimum log level.

### Sending log messages

Use `server.sendLoggingMessage()` to emit structured log messages to clients:

```typescript
server.sendLoggingMessage({
    level: 'info',
    logger: 'my-server',
    data: 'Processing request...'
});
```

### Handling setLevel requests

Clients can request a minimum logging level via `logging/setLevel`. If you create a `Server` with `capabilities: { logging: {} }`, a default handler is registered that tracks the level per session. You can also add custom logic:

```typescript
import { SetLevelRequestSchema } from '@modelcontextprotocol/sdk/types.js';

server.server.setRequestHandler(SetLevelRequestSchema, async (request) => {
    const level = request.params.level;
    console.log(`Client requested log level: ${level}`);
    // Update your logging configuration
    return {};
});
```

On the client side, request a log level with:

```typescript
await client.setLoggingLevel('debug');
```

Available levels (from most to least verbose): `debug`, `info`, `notice`, `warning`, `error`, `critical`, `alert`, `emergency`.

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
