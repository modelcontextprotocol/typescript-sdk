---
title: Client Guide
---

# Building MCP clients

This guide covers the TypeScript SDK APIs for building MCP clients. For protocol-level concepts, see the [MCP overview](https://modelcontextprotocol.io/docs/learn/architecture).

A client connects to a server, discovers what it offers — tools, resources, prompts — and invokes them. Beyond that core loop, this guide covers authentication, error handling, and responding to server-initiated requests like sampling and elicitation.

## Imports

The examples below use these imports. Adjust based on which features and transport you need:

```ts source="../examples/client/src/clientGuide.examples.ts#imports"
import type { Prompt, Resource, Tool } from '@modelcontextprotocol/client';
import {
    applyMiddlewares,
    CallToolResultSchema,
    Client,
    ClientCredentialsProvider,
    createMiddleware,
    PrivateKeyJwtProvider,
    ProtocolError,
    SdkError,
    SdkErrorCode,
    SSEClientTransport,
    StdioClientTransport,
    StreamableHTTPClientTransport
} from '@modelcontextprotocol/client';
```

## Connecting to a server

### Streamable HTTP

For remote HTTP servers, use {@linkcode @modelcontextprotocol/client!client/streamableHttp.StreamableHTTPClientTransport | StreamableHTTPClientTransport}:

```ts source="../examples/client/src/clientGuide.examples.ts#connect_streamableHttp"
const client = new Client({ name: 'my-client', version: '1.0.0' });

const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'));

await client.connect(transport);
```

For a full interactive client over Streamable HTTP, see [`simpleStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/simpleStreamableHttp.ts).

### stdio

For local, process-spawned servers (Claude Desktop, CLI tools), use {@linkcode @modelcontextprotocol/client!client/stdio.StdioClientTransport | StdioClientTransport}. The transport spawns the server process and communicates over stdin/stdout:

```ts source="../examples/client/src/clientGuide.examples.ts#connect_stdio"
const client = new Client({ name: 'my-client', version: '1.0.0' });

const transport = new StdioClientTransport({
    command: 'node',
    args: ['server.js']
});

await client.connect(transport);
```

### SSE fallback for legacy servers

To support both modern Streamable HTTP and legacy SSE servers, try {@linkcode @modelcontextprotocol/client!client/streamableHttp.StreamableHTTPClientTransport | StreamableHTTPClientTransport} first and fall back to {@linkcode @modelcontextprotocol/client!client/sse.SSEClientTransport | SSEClientTransport} on failure:

```ts source="../examples/client/src/clientGuide.examples.ts#connect_sseFallback"
const baseUrl = new URL(url);

try {
    // Try modern Streamable HTTP transport first
    const client = new Client({ name: 'my-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(baseUrl);
    await client.connect(transport);
    return { client, transport };
} catch {
    // Fall back to legacy SSE transport
    const client = new Client({ name: 'my-client', version: '1.0.0' });
    const transport = new SSEClientTransport(baseUrl);
    await client.connect(transport);
    return { client, transport };
}
```

For a complete example with error reporting, see [`streamableHttpWithSseFallbackClient.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/streamableHttpWithSseFallbackClient.ts).

### Disconnecting

Call {@linkcode @modelcontextprotocol/client!client/client.Client#close | await client.close() } to disconnect. Pending requests are rejected with a {@linkcode @modelcontextprotocol/client!index.SdkErrorCode.ConnectionClosed | CONNECTION_CLOSED} error.

For Streamable HTTP, terminate the server-side session first (per the MCP specification):

```ts source="../examples/client/src/clientGuide.examples.ts#disconnect_streamableHttp"
await transport.terminateSession(); // notify the server (recommended)
await client.close();
```

For stdio, `client.close()` handles graceful process shutdown (closes stdin, then SIGTERM, then SIGKILL if needed).

### Server instructions

Servers can provide an `instructions` string during initialization that describes how to use them — cross-tool relationships, workflow patterns, and constraints (see [Instructions](https://modelcontextprotocol.io/specification/latest/basic/lifecycle#instructions) in the MCP specification). Retrieve it after connecting and include it in the model's system prompt:

```ts source="../examples/client/src/clientGuide.examples.ts#serverInstructions_basic"
const instructions = client.getInstructions();

const systemPrompt = ['You are a helpful assistant.', instructions].filter(Boolean).join('\n\n');

console.log(systemPrompt);
```

## Authentication

MCP servers can require OAuth 2.0 authentication before accepting client connections (see [Authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization) in the MCP specification). Pass an `authProvider` to {@linkcode @modelcontextprotocol/client!client/streamableHttp.StreamableHTTPClientTransport | StreamableHTTPClientTransport} to enable this — the SDK provides built-in providers for common machine-to-machine flows, or you can implement the full {@linkcode @modelcontextprotocol/client!client/auth.OAuthClientProvider | OAuthClientProvider} interface for user-facing OAuth.

### Client credentials

{@linkcode @modelcontextprotocol/client!client/authExtensions.ClientCredentialsProvider | ClientCredentialsProvider} handles the `client_credentials` grant flow for service-to-service communication:

```ts source="../examples/client/src/clientGuide.examples.ts#auth_clientCredentials"
const authProvider = new ClientCredentialsProvider({
    clientId: 'my-service',
    clientSecret: 'my-secret'
});

const client = new Client({ name: 'my-client', version: '1.0.0' });

const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'), { authProvider });

await client.connect(transport);
```

### Private key JWT

{@linkcode @modelcontextprotocol/client!client/authExtensions.PrivateKeyJwtProvider | PrivateKeyJwtProvider} signs JWT assertions for the `private_key_jwt` token endpoint auth method, avoiding a shared client secret:

```ts source="../examples/client/src/clientGuide.examples.ts#auth_privateKeyJwt"
const authProvider = new PrivateKeyJwtProvider({
    clientId: 'my-service',
    privateKey: pemEncodedKey,
    algorithm: 'RS256'
});

const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'), { authProvider });
```

For a runnable example supporting both auth methods via environment variables, see [`simpleClientCredentials.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/simpleClientCredentials.ts).

### Full OAuth with user authorization

For user-facing applications, implement the {@linkcode @modelcontextprotocol/client!client/auth.OAuthClientProvider | OAuthClientProvider} interface to handle the full authorization code flow (redirects, code verifiers, token storage, dynamic client registration). The {@linkcode @modelcontextprotocol/client!client/client.Client#connect | connect()} call will throw {@linkcode @modelcontextprotocol/client!client/auth.UnauthorizedError | UnauthorizedError} when authorization is needed — catch it, complete the browser flow, call {@linkcode @modelcontextprotocol/client!client/streamableHttp.StreamableHTTPClientTransport#finishAuth | transport.finishAuth(code)}, and reconnect.

For a complete working OAuth flow, see [`simpleOAuthClient.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/simpleOAuthClient.ts) and [`simpleOAuthClientProvider.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/simpleOAuthClientProvider.ts).

## Tools

Tools are callable actions offered by servers — discovering and invoking them is usually how your client enables an LLM to take action (see [Tools](https://modelcontextprotocol.io/docs/learn/server-concepts#tools) in the MCP overview).

Use {@linkcode @modelcontextprotocol/client!client/client.Client#listTools | listTools()} to discover available tools, and {@linkcode @modelcontextprotocol/client!client/client.Client#callTool | callTool()} to invoke one. Results may be paginated — loop on `nextCursor` to collect all pages:

```ts source="../examples/client/src/clientGuide.examples.ts#callTool_basic"
const allTools: Tool[] = [];
let toolCursor: string | undefined;
do {
    const { tools, nextCursor } = await client.listTools({ cursor: toolCursor });
    allTools.push(...tools);
    toolCursor = nextCursor;
} while (toolCursor);
console.log(
    'Available tools:',
    allTools.map(t => t.name)
);

const result = await client.callTool({
    name: 'calculate-bmi',
    arguments: { weightKg: 70, heightM: 1.75 }
});
console.log(result.content);
```

Tool results may include a `structuredContent` field — a machine-readable JSON object for programmatic use by the client application, complementing `content` which is for the LLM:

```ts source="../examples/client/src/clientGuide.examples.ts#callTool_structuredOutput"
const result = await client.callTool({
    name: 'calculate-bmi',
    arguments: { weightKg: 70, heightM: 1.75 }
});

// Machine-readable output for the client application
if (result.structuredContent) {
    console.log(result.structuredContent); // e.g. { bmi: 22.86 }
}
```

### Tracking progress

Pass `onprogress` to receive incremental progress notifications from long-running tools. Use `resetTimeoutOnProgress` to keep the request alive while the server is actively reporting, and `maxTotalTimeout` as an absolute cap:

```ts source="../examples/client/src/clientGuide.examples.ts#callTool_progress"
const result = await client.callTool({ name: 'long-operation', arguments: {} }, undefined, {
    onprogress: ({ progress, total }) => {
        console.log(`Progress: ${progress}/${total ?? '?'}`);
    },
    resetTimeoutOnProgress: true,
    maxTotalTimeout: 600_000
});
console.log(result.content);
```

## Resources

Resources are read-only data — files, database schemas, configuration — that your application can retrieve from a server and attach as context for the model (see [Resources](https://modelcontextprotocol.io/docs/learn/server-concepts#resources) in the MCP overview).

Use {@linkcode @modelcontextprotocol/client!client/client.Client#listResources | listResources()} and {@linkcode @modelcontextprotocol/client!client/client.Client#readResource | readResource()} to discover and read server-provided data. Results may be paginated — loop on `nextCursor` to collect all pages:

```ts source="../examples/client/src/clientGuide.examples.ts#readResource_basic"
const allResources: Resource[] = [];
let resourceCursor: string | undefined;
do {
    const { resources, nextCursor } = await client.listResources({ cursor: resourceCursor });
    allResources.push(...resources);
    resourceCursor = nextCursor;
} while (resourceCursor);
console.log(
    'Available resources:',
    allResources.map(r => r.name)
);

const { contents } = await client.readResource({ uri: 'config://app' });
for (const item of contents) {
    console.log(item);
}
```

To discover URI templates for dynamic resources, use {@linkcode @modelcontextprotocol/client!client/client.Client#listResourceTemplates | listResourceTemplates()}.

### Subscribing to resource changes

If the server supports resource subscriptions, use {@linkcode @modelcontextprotocol/client!client/client.Client#subscribeResource | subscribeResource()} to receive notifications when a resource changes, then re-read it:

```ts source="../examples/client/src/clientGuide.examples.ts#subscribeResource_basic"
await client.subscribeResource({ uri: 'config://app' });

client.setNotificationHandler('notifications/resources/updated', async notification => {
    if (notification.params.uri === 'config://app') {
        const { contents } = await client.readResource({ uri: 'config://app' });
        console.log('Config updated:', contents);
    }
});

// Later: stop receiving updates
await client.unsubscribeResource({ uri: 'config://app' });
```

## Prompts

Prompts are reusable message templates that servers offer to help structure interactions with models (see [Prompts](https://modelcontextprotocol.io/docs/learn/server-concepts#prompts) in the MCP overview).

Use {@linkcode @modelcontextprotocol/client!client/client.Client#listPrompts | listPrompts()} and {@linkcode @modelcontextprotocol/client!client/client.Client#getPrompt | getPrompt()} to list available prompts and retrieve them with arguments. Results may be paginated — loop on `nextCursor` to collect all pages:

```ts source="../examples/client/src/clientGuide.examples.ts#getPrompt_basic"
const allPrompts: Prompt[] = [];
let promptCursor: string | undefined;
do {
    const { prompts, nextCursor } = await client.listPrompts({ cursor: promptCursor });
    allPrompts.push(...prompts);
    promptCursor = nextCursor;
} while (promptCursor);
console.log(
    'Available prompts:',
    allPrompts.map(p => p.name)
);

const { messages } = await client.getPrompt({
    name: 'review-code',
    arguments: { code: 'console.log("hello")' }
});
console.log(messages);
```

## Completions

Both prompts and resources can support argument completions. Use {@linkcode @modelcontextprotocol/client!client/client.Client#complete | complete()} to request autocompletion suggestions from the server as a user types:

```ts source="../examples/client/src/clientGuide.examples.ts#complete_basic"
const { completion } = await client.complete({
    ref: {
        type: 'ref/prompt',
        name: 'review-code'
    },
    argument: {
        name: 'language',
        value: 'type'
    }
});
console.log(completion.values); // e.g. ['typescript']
```

## Notifications

### Automatic list-change tracking

The {@linkcode @modelcontextprotocol/client!client/client.ClientOptions | listChanged} client option keeps a local cache of tools, prompts, or resources in sync with the server. It provides automatic server capability gating, debouncing (300 ms by default), auto-refresh, and error-first callbacks:

```ts source="../examples/client/src/clientGuide.examples.ts#listChanged_basic"
const client = new Client(
    { name: 'my-client', version: '1.0.0' },
    {
        listChanged: {
            tools: {
                onChanged: (error, tools) => {
                    if (error) {
                        console.error('Failed to refresh tools:', error);
                        return;
                    }
                    console.log('Tools updated:', tools);
                }
            },
            prompts: {
                onChanged: (error, prompts) => console.log('Prompts updated:', prompts)
            }
        }
    }
);
```

### Manual notification handlers

For full control — or for notification types not covered by `listChanged` (such as log messages) — register handlers directly with {@linkcode @modelcontextprotocol/client!client/client.Client#setNotificationHandler | setNotificationHandler()}:

```ts source="../examples/client/src/clientGuide.examples.ts#notificationHandler_basic"
// Server log messages (sent by the server during request processing)
client.setNotificationHandler('notifications/message', notification => {
    const { level, data } = notification.params;
    console.log(`[${level}]`, data);
});

// Server's resource list changed — re-fetch the list
client.setNotificationHandler('notifications/resources/list_changed', async () => {
    const { resources } = await client.listResources();
    console.log('Resources changed:', resources.length);
});
```

To control the minimum severity of log messages the server sends, use {@linkcode @modelcontextprotocol/client!client/client.Client#setLoggingLevel | setLoggingLevel()}:

```ts source="../examples/client/src/clientGuide.examples.ts#setLoggingLevel_basic"
await client.setLoggingLevel('warning');
```

> [!WARNING]
> `listChanged` and {@linkcode @modelcontextprotocol/client!client/client.Client#setNotificationHandler | setNotificationHandler()} are mutually exclusive per notification type — using both for the same notification will cause the manual handler to be overwritten.

## Handling server-initiated requests

MCP is bidirectional — servers can send requests *to* the client during tool execution, as long as the client declares matching capabilities (see [Architecture](https://modelcontextprotocol.io/docs/learn/architecture) in the MCP overview). Declare the corresponding capability when constructing the {@linkcode @modelcontextprotocol/client!client/client.Client | Client} and register a request handler:

```ts source="../examples/client/src/clientGuide.examples.ts#capabilities_declaration"
const client = new Client(
    { name: 'my-client', version: '1.0.0' },
    {
        capabilities: {
            sampling: {},
            elicitation: { form: {} }
        }
    }
);
```

### Sampling

When a server needs an LLM completion during tool execution, it sends a `sampling/createMessage` request to the client (see [Sampling](https://modelcontextprotocol.io/docs/learn/client-concepts#sampling) in the MCP overview). Register a handler to fulfill it:

```ts source="../examples/client/src/clientGuide.examples.ts#sampling_handler"
client.setRequestHandler('sampling/createMessage', async request => {
    const lastMessage = request.params.messages.at(-1);
    console.log('Sampling request:', lastMessage);

    // In production, send messages to your LLM here
    return {
        model: 'my-model',
        role: 'assistant' as const,
        content: {
            type: 'text' as const,
            text: 'Response from the model'
        }
    };
});
```

### Elicitation

When a server needs user input during tool execution, it sends an `elicitation/create` request to the client (see [Elicitation](https://modelcontextprotocol.io/docs/learn/client-concepts#elicitation) in the MCP overview). The client should present the form to the user and return the collected data, or `{ action: 'decline' }`:

```ts source="../examples/client/src/clientGuide.examples.ts#elicitation_handler"
client.setRequestHandler('elicitation/create', async request => {
    console.log('Server asks:', request.params.message);

    if (request.params.mode === 'form') {
        // Present the schema-driven form to the user
        console.log('Schema:', request.params.requestedSchema);
        return { action: 'accept', content: { confirm: true } };
    }

    return { action: 'decline' };
});
```

For a full form-based elicitation handler with AJV validation, see [`simpleStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/simpleStreamableHttp.ts). For URL elicitation mode, see [`elicitationUrlExample.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/elicitationUrlExample.ts).

### Roots

Roots let the client expose filesystem boundaries to the server (see [Roots](https://modelcontextprotocol.io/docs/learn/client-concepts#roots) in the MCP overview). Declare the `roots` capability and register a `roots/list` handler:

```ts source="../examples/client/src/clientGuide.examples.ts#roots_handler"
client.setRequestHandler('roots/list', async () => {
    return {
        roots: [
            { uri: 'file:///home/user/projects/my-app', name: 'My App' },
            { uri: 'file:///home/user/data', name: 'Data' }
        ]
    };
});
```

When the available roots change, notify the server with {@linkcode @modelcontextprotocol/client!client/client.Client#sendRootsListChanged | client.sendRootsListChanged()}.

## Error handling

### Tool errors vs protocol errors

{@linkcode @modelcontextprotocol/client!client/client.Client#callTool | callTool()} has two error surfaces: the tool can *run but report failure* via `isError: true` in the result, or the *request itself can fail* and throw an exception. Always check both:

```ts source="../examples/client/src/clientGuide.examples.ts#errorHandling_toolErrors"
try {
    const result = await client.callTool({
        name: 'fetch-data',
        arguments: { url: 'https://example.com' }
    });

    // Tool-level error: the tool ran but reported a problem
    if (result.isError) {
        console.error('Tool error:', result.content);
        return;
    }

    console.log('Success:', result.content);
} catch (error) {
    // Protocol-level error: the request itself failed
    if (error instanceof ProtocolError) {
        console.error(`Protocol error ${error.code}: ${error.message}`);
    } else if (error instanceof SdkError) {
        console.error(`SDK error [${error.code}]: ${error.message}`);
    } else {
        throw error;
    }
}
```

{@linkcode @modelcontextprotocol/client!index.ProtocolError | ProtocolError} represents JSON-RPC errors from the server (method not found, invalid params, internal error). {@linkcode @modelcontextprotocol/client!index.SdkError | SdkError} represents local SDK errors — {@linkcode @modelcontextprotocol/client!index.SdkErrorCode.RequestTimeout | REQUEST_TIMEOUT}, {@linkcode @modelcontextprotocol/client!index.SdkErrorCode.ConnectionClosed | CONNECTION_CLOSED}, {@linkcode @modelcontextprotocol/client!index.SdkErrorCode.CapabilityNotSupported | CAPABILITY_NOT_SUPPORTED}, and others.

### Connection lifecycle

Set {@linkcode @modelcontextprotocol/client!client/client.Client#onerror | client.onerror} to catch out-of-band transport errors (SSE disconnects, parse errors). Set {@linkcode @modelcontextprotocol/client!client/client.Client#onclose | client.onclose} to detect when the connection drops — pending requests are rejected with a {@linkcode @modelcontextprotocol/client!index.SdkErrorCode.ConnectionClosed | CONNECTION_CLOSED} error:

```ts source="../examples/client/src/clientGuide.examples.ts#errorHandling_lifecycle"
// Out-of-band errors (SSE disconnects, parse errors)
client.onerror = error => {
    console.error('Transport error:', error.message);
};

// Connection closed (pending requests are rejected with CONNECTION_CLOSED)
client.onclose = () => {
    console.log('Connection closed');
};
```

### Timeouts

All requests have a 60-second default timeout. Pass a custom `timeout` in the options to override it. On timeout, the SDK sends a cancellation notification to the server and rejects the promise with {@linkcode @modelcontextprotocol/client!index.SdkErrorCode.RequestTimeout | SdkErrorCode.RequestTimeout}:

```ts source="../examples/client/src/clientGuide.examples.ts#errorHandling_timeout"
try {
    const result = await client.callTool(
        { name: 'slow-task', arguments: {} },
        undefined,
        { timeout: 120_000 } // 2 minutes instead of the default 60 seconds
    );
    console.log(result.content);
} catch (error) {
    if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) {
        console.error('Request timed out');
    }
}
```

## Client middleware

Use {@linkcode @modelcontextprotocol/client!client/middleware.createMiddleware | createMiddleware()} and {@linkcode @modelcontextprotocol/client!client/middleware.applyMiddlewares | applyMiddlewares()} to compose fetch middleware pipelines. Middleware wraps the underlying `fetch` call and can add headers, handle retries, or log requests. Pass the enhanced fetch to the transport via the `fetch` option:

```ts source="../examples/client/src/clientGuide.examples.ts#middleware_basic"
const authMiddleware = createMiddleware(async (next, input, init) => {
    const headers = new Headers(init?.headers);
    headers.set('X-Custom-Header', 'my-value');
    return next(input, { ...init, headers });
});

const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'), {
    fetch: applyMiddlewares(authMiddleware)(fetch)
});
```

## Resumption tokens

When using SSE-based streaming, the server can assign event IDs. Pass `onresumptiontoken` to track them, and `resumptionToken` to resume from where you left off after a disconnection:

```ts source="../examples/client/src/clientGuide.examples.ts#resumptionToken_basic"
let lastToken: string | undefined;

const result = await client.request(
    {
        method: 'tools/call',
        params: { name: 'long-running-task', arguments: {} }
    },
    CallToolResultSchema,
    {
        resumptionToken: lastToken,
        onresumptiontoken: (token: string) => {
            lastToken = token;
            // Persist token to survive restarts
        }
    }
);
console.log(result);
```

For an end-to-end example of server-initiated SSE disconnection and automatic client reconnection with event replay, see [`ssePollingClient.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/ssePollingClient.ts).

## Tasks (experimental)

> [!WARNING]
> The tasks API is experimental and may change without notice.

Task-based execution enables "call-now, fetch-later" patterns for long-running operations (see [Tasks](https://modelcontextprotocol.io/specification/latest/basic/utilities/tasks) in the MCP specification). Instead of returning a result immediately, a tool creates a task that can be polled or resumed later. To use tasks:

- Call {@linkcode @modelcontextprotocol/client!experimental/tasks/client.ExperimentalClientTasks#callToolStream | client.experimental.tasks.callToolStream(...)} to start a tool call that may create a task and emit status updates over time.
- Call {@linkcode @modelcontextprotocol/client!experimental/tasks/client.ExperimentalClientTasks#getTask | client.experimental.tasks.getTask(...)} and {@linkcode @modelcontextprotocol/client!experimental/tasks/client.ExperimentalClientTasks#getTaskResult | getTaskResult(...)} to check status and fetch results after reconnecting.

For a full runnable example, see [`simpleTaskInteractiveClient.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/simpleTaskInteractiveClient.ts).

## See also

- [`examples/client/`](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/examples/client) — Full runnable client examples
- [Server guide](./server.md) — Building MCP servers with this SDK
- [MCP overview](https://modelcontextprotocol.io/docs/learn/architecture) — Protocol-level concepts: participants, layers, primitives
- [Migration guide](./migration.md) — Upgrading from previous SDK versions
- [FAQ](./faq.md) — Frequently asked questions and troubleshooting

### Additional examples

| Feature | Description | Example |
|---------|-------------|---------|
| Parallel tool calls | Run multiple tool calls concurrently via `Promise.all` | [`parallelToolCallsClient.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/parallelToolCallsClient.ts) |
| SSE disconnect / reconnection | Server-initiated SSE disconnect with automatic reconnection and event replay | [`ssePollingClient.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/ssePollingClient.ts) |
| Multiple clients | Independent client lifecycles to the same server | [`multipleClientsParallel.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/multipleClientsParallel.ts) |
| URL elicitation | Handle sensitive data collection via browser | [`elicitationUrlExample.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/elicitationUrlExample.ts) |
