---
title: Client
---

## Client overview

This guide covers SDK usage for building MCP clients in TypeScript. For protocol-level details and message formats, see the [MCP specification](https://modelcontextprotocol.io/specification/latest/).

The SDK provides a {@linkcode @modelcontextprotocol/client!client/client.Client | Client} class from `@modelcontextprotocol/client` that connects to MCP servers over different transports:

- **Streamable HTTP** – for remote HTTP servers.
- **stdio** – for local processes you spawn.
- **SSE** – for legacy HTTP+SSE servers (deprecated).

For a feature‑rich starting point, see [`simpleStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/simpleStreamableHttp.ts).

## Connecting to a server

Construct a `Client` with a name and version, create a transport, and call {@linkcode @modelcontextprotocol/client!client/client.Client#connect | client.connect(transport)}. The client automatically performs the MCP initialization handshake.

### Streamable HTTP

For remote HTTP servers, use {@linkcode @modelcontextprotocol/client!client/streamableHttp.StreamableHTTPClientTransport | StreamableHTTPClientTransport}:

```ts source="../examples/client/src/clientGuide.examples.ts#connect_streamableHttp"
const client = new Client({ name: 'my-client', version: '1.0.0' });

const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'));

await client.connect(transport);
```

> [!NOTE]
> For a full interactive client over Streamable HTTP, see [`simpleStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/simpleStreamableHttp.ts).

### stdio

For local, process‑spawned servers (Claude Desktop, CLI tools), use {@linkcode @modelcontextprotocol/client!client/stdio.StdioClientTransport | StdioClientTransport}. The transport spawns the server process and communicates over stdin/stdout:

```ts source="../examples/client/src/clientGuide.examples.ts#connect_stdio"
const client = new Client({ name: 'my-client', version: '1.0.0' });

const transport = new StdioClientTransport({
    command: 'node',
    args: ['server.js']
});

await client.connect(transport);
```

### SSE fallback for legacy servers

To support both modern Streamable HTTP and legacy SSE servers, try `StreamableHTTPClientTransport` first and fall back to {@linkcode @modelcontextprotocol/client!client/sse.SSEClientTransport | SSEClientTransport} on failure:

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

> [!NOTE]
> For a complete example with error reporting, see [`streamableHttpWithSseFallbackClient.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/streamableHttpWithSseFallbackClient.ts).

## Authentication

For OAuth‑secured MCP servers, pass an `authProvider` to `StreamableHTTPClientTransport`. The SDK provides built‑in providers for common machine‑to‑machine flows, or you can implement the full {@linkcode @modelcontextprotocol/client!client/auth.OAuthClientProvider | OAuthClientProvider} interface for user‑facing OAuth.

### Client credentials

{@linkcode @modelcontextprotocol/client!client/authExtensions.ClientCredentialsProvider | ClientCredentialsProvider} handles the `client_credentials` grant flow for service‑to‑service communication:

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

> [!NOTE]
> For a runnable example supporting both auth methods via environment variables, see [`simpleClientCredentials.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/simpleClientCredentials.ts).

### Full OAuth with user authorization

For user‑facing applications, implement the `OAuthClientProvider` interface to handle the full authorization code flow (redirects, code verifiers, token storage, dynamic client registration). The `connect()` call will throw `UnauthorizedError` when authorization is needed — catch it, complete the browser flow, call `transport.finishAuth(code)`, and reconnect.

> [!NOTE]
> For a complete working OAuth flow, see [`simpleOAuthClient.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/simpleOAuthClient.ts) and [`simpleOAuthClientProvider.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/simpleOAuthClientProvider.ts).
>
> For protocol details, see [Authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization) in the MCP specification.

## Using server features

Once connected, the `Client` provides high‑level helpers for the three core MCP primitives: tools, resources, and prompts. These handle JSON‑RPC request/response encoding automatically.

> [!NOTE]
> For a full runnable client exercising tools, resources, and prompts, see [`simpleStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/simpleStreamableHttp.ts).

### Tools

Use {@linkcode @modelcontextprotocol/client!client/client.Client#listTools | listTools()} to discover available tools, and {@linkcode @modelcontextprotocol/client!client/client.Client#callTool | callTool()} to invoke one:

```ts source="../examples/client/src/clientGuide.examples.ts#callTool_basic"
const { tools } = await client.listTools();
console.log(
    'Available tools:',
    tools.map(t => t.name)
);

const result = await client.callTool({
    name: 'calculate-bmi',
    arguments: { weightKg: 70, heightM: 1.75 }
});
console.log(result.content);
```

> [!NOTE]
> See [Tools](https://modelcontextprotocol.io/specification/latest/server/tools) in the MCP specification for the full protocol details.

### Resources

Use {@linkcode @modelcontextprotocol/client!client/client.Client#listResources | listResources()} and {@linkcode @modelcontextprotocol/client!client/client.Client#readResource | readResource()} to discover and read server‑provided data:

```ts source="../examples/client/src/clientGuide.examples.ts#readResource_basic"
const { resources } = await client.listResources();
console.log(
    'Available resources:',
    resources.map(r => r.name)
);

const { contents } = await client.readResource({ uri: 'config://app' });
for (const item of contents) {
    console.log(item);
}
```

> [!NOTE]
> See [Resources](https://modelcontextprotocol.io/specification/latest/server/resources) in the MCP specification for the full protocol details.

### Prompts

Use {@linkcode @modelcontextprotocol/client!client/client.Client#listPrompts | listPrompts()} and {@linkcode @modelcontextprotocol/client!client/client.Client#getPrompt | getPrompt()} to retrieve prompt templates from the server:

```ts source="../examples/client/src/clientGuide.examples.ts#getPrompt_basic"
const { prompts } = await client.listPrompts();
console.log(
    'Available prompts:',
    prompts.map(p => p.name)
);

const { messages } = await client.getPrompt({
    name: 'review-code',
    arguments: { code: 'console.log("hello")' }
});
console.log(messages);
```

> [!NOTE]
> See [Prompts](https://modelcontextprotocol.io/specification/latest/server/prompts) in the MCP specification for the full protocol details.

### Completions

If a server supports argument completions on prompts or resources, use {@linkcode @modelcontextprotocol/client!client/client.Client#complete | complete()} to request suggestions. This is the client‑side counterpart to {@linkcode @modelcontextprotocol/server!server/completable.completable | completable()} on the server:

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

### Automatic list‑change tracking

The `listChanged` client option keeps a local cache of tools, prompts, or resources in sync with the server. Compared to manually handling notifications, it provides automatic server capability gating, debouncing (300 ms by default), auto‑refresh, and error‑first callbacks:

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
// Server log messages (e.g. from ctx.mcpReq.log() in tool handlers)
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

Note that `listChanged` and `setNotificationHandler` are mutually exclusive per notification type — using both for the same notification will cause the manual handler to be overwritten.

## Handling server‑initiated requests

MCP is bidirectional — servers can also send requests *to* the client. To handle these, declare the corresponding capability when constructing the `Client` and register a request handler. The two main server‑initiated request types are **sampling** (LLM completions) and **elicitation** (user input).

### Declaring capabilities

Pass a {@linkcode @modelcontextprotocol/client!client/client.ClientOptions | `capabilities`} object when constructing the `Client`. The server reads these during initialization and will only send requests your client has declared support for:

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

When a server calls `server.createMessage(...)` inside a tool handler, the request is routed to the client. Register a handler for `sampling/createMessage` to fulfill it:

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

> [!NOTE]
> See [Sampling](https://modelcontextprotocol.io/specification/latest/client/sampling) in the MCP specification for the full protocol details.

### Elicitation

When a server calls `server.elicitInput(...)`, the request arrives at the client as an `elicitation/create` request. The client should present the form to the user and return the collected data, or `{ action: 'decline' }`:

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

> [!NOTE]
> For a full form‑based elicitation handler with AJV validation, see [`simpleStreamableHttp.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/simpleStreamableHttp.ts). For URL elicitation mode, see [`elicitationUrlExample.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/elicitationUrlExample.ts) and the [Capabilities guide](capabilities.md#elicitation).
>
> For protocol details, see [Elicitation](https://modelcontextprotocol.io/specification/latest/client/elicitation) in the MCP specification.

## Advanced patterns

### Client middleware

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

### Resumption tokens

When using SSE‑based streaming, the server can assign event IDs. Pass `onresumptiontoken` to track them, and `resumptionToken` to resume from where you left off after a disconnection:

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

> [!NOTE]
> For an end‑to‑end example of server‑initiated SSE disconnection and automatic client reconnection with event replay, see [`ssePollingClient.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/ssePollingClient.ts).

## More client features

The sections above cover the essentials. The table below links to additional capabilities.

| Feature | Description | Reference |
|---------|-------------|-----------|
| Parallel tool calls | Run multiple tool calls concurrently via `Promise.all` | [`parallelToolCallsClient.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/parallelToolCallsClient.ts) |
| SSE disconnect / reconnection | Server‑initiated SSE disconnect with automatic reconnection and event replay | [`ssePollingClient.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/ssePollingClient.ts) |
| Multiple clients | Independent client lifecycles to the same server | [`multipleClientsParallel.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/multipleClientsParallel.ts) |
| URL elicitation | Handle sensitive data collection via browser | [`elicitationUrlExample.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/elicitationUrlExample.ts) |
| Tasks (experimental) | Long‑running tool calls with status streaming | [`simpleTaskInteractiveClient.ts`](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/examples/client/src/simpleTaskInteractiveClient.ts), [Capabilities guide](capabilities.md#task-based-execution-experimental) |
