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
    console.log(
        'Tools updated:',
        tools.map(t => t.name)
    );
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

#### Resource templates

Dynamic resources use `ResourceTemplate` with URI patterns containing variables. When a client reads a URI matching the pattern, the SDK extracts the variables and passes them to your handler:

```typescript
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';

server.registerResource('user-profile', new ResourceTemplate('users://{userId}/profile', { list: undefined }), { title: 'User Profile', mimeType: 'application/json' }, async (uri, variables) => ({
    contents: [
        {
            uri: uri.toString(),
            mimeType: 'application/json',
            text: JSON.stringify({ userId: variables.userId, name: 'Example User' })
        }
    ]
}));
```

Templates can also provide argument completions — see the [Completions](#completions) section below.

#### Subscribing and unsubscribing

Clients can subscribe to resource changes. When a subscribed resource is updated, the server sends a notification so the client can re-read it:

```typescript
// Client side: subscribe to a resource
await client.subscribeResource({ uri: 'config://app' });

// Client side: listen for update notifications
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

client.setNotificationHandler(ResourceUpdatedNotificationSchema, async notification => {
    const { uri } = notification.params;
    const updated = await client.readResource({ uri });
    console.log('Resource updated:', updated);
});

// Client side: unsubscribe when no longer interested
await client.unsubscribeResource({ uri: 'config://app' });
```

On the server side, emit update notifications when resources change:

```typescript
server.sendResourceUpdated(new URL('config://app'));
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
server.registerPrompt('analyze-screenshot', { description: 'Analyze a screenshot' }, async () => ({
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
}));
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
    console.log(
        'Prompts updated:',
        prompts.map(p => p.name)
    );
});
```

### Completions

Both prompts and resources can support argument completions, providing autocomplete suggestions as users type.

#### Resource template completions

Pass `complete` callbacks when creating a `ResourceTemplate`:

```typescript
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';

server.registerResource(
    'docs',
    new ResourceTemplate('docs://{category}/{page}', {
        list: undefined,
        complete: {
            category: () => ['guides', 'api-reference', 'tutorials'],
            page: value => ['getting-started', 'installation', 'configuration']
        }
    }),
    { title: 'Documentation' },
    async (uri, variables) => ({
        contents: [{ uri: uri.toString(), text: `Doc: ${variables.category}/${variables.page}` }]
    })
);
```

#### Prompt argument completions

Use the `completable()` wrapper around Zod schemas in prompt argument definitions:

```typescript
import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import { z } from 'zod';

server.registerPrompt(
    'greet',
    {
        description: 'Greet someone',
        argsSchema: {
            name: completable(z.string(), () => ['Alice', 'Bob', 'Charlie']),
            language: completable(z.string(), value => ['en', 'es', 'fr'].filter(l => l.startsWith(value)))
        }
    },
    async ({ name, language }) => ({
        messages: [{ role: 'user', content: { type: 'text', text: `Hello ${name} in ${language}` } }]
    })
);
```

On the client side, request completions with `client.complete()`.

### Display names and metadata

Tools, resources and prompts support a `title` field for human‑readable names. Older APIs can also attach `annotations.title`. To compute the correct display name on the client, use:

- `getDisplayName` from `@modelcontextprotocol/sdk/shared/metadataUtils.js`

## Ping

Both clients and servers can send pings to check that the other side is responsive. The SDK handles ping requests automatically — no handler registration is needed:

```typescript
// Server pings the client
await server.ping();

// Client pings the server
await client.ping();
```

If the remote side does not respond, the ping will throw after the request timeout.

## stdio transport

For local integrations where the client spawns the server as a child process, use stdio transport:

```typescript
// Server: read from stdin, write to stdout
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'my-server', version: '1.0.0' });
// ... register tools, resources, prompts ...

const transport = new StdioServerTransport();
await server.connect(transport);
```

For the client side, see [stdio in the client docs](./client.md#stdio-transport).

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

server.server.setRequestHandler(SetLevelRequestSchema, async request => {
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
