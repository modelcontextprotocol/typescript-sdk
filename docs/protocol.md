## Protocol features

This page covers cross-cutting protocol mechanics that apply to both clients and servers.

## Ping

Both client and server expose a `ping()` method for health checks. The remote side responds automatically — no handler registration is needed.

```typescript
// Client pinging the server:
await client.ping();

// With a timeout (milliseconds):
await client.ping({ timeout: 5000 });

// Server pinging the client (via the low-level server, no timeout option):
await server.server.ping();
```

## Progress notifications

Long-running requests can report progress to the caller. The SDK handles `progressToken` assignment automatically when you provide an `onprogress` callback.

**Receiving progress** (client side):

```typescript
const result = await client.callTool({ name: 'long-task', arguments: {} }, CallToolResultSchema, {
    onprogress: progress => {
        // progress has: { progress: number, total?: number, message?: string }
        console.log(`${progress.progress}/${progress.total}: ${progress.message}`);
    },
    timeout: 30000,
    resetTimeoutOnProgress: true
});
```

**Sending progress** (server side, from a tool handler):

```typescript
server.registerTool(
    'count',
    {
        description: 'Count to N with progress updates',
        inputSchema: { n: z.number() }
    },
    async ({ n }, extra) => {
        for (let i = 1; i <= n; i++) {
            if (extra._meta?.progressToken !== undefined) {
                await extra.sendNotification({
                    method: 'notifications/progress',
                    params: {
                        progressToken: extra._meta.progressToken,
                        progress: i,
                        total: n,
                        message: `Counting: ${i}/${n}`
                    }
                });
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return { content: [{ type: 'text', text: `Counted to ${n}` }] };
    }
);
```

For a runnable example, see [`progressExample.ts`](../src/examples/server/progressExample.ts).

## Cancellation

Requests can be cancelled by the caller using an `AbortSignal`. The SDK sends a `notifications/cancelled` message to the remote side and aborts the handler via its `signal`.

**Client cancelling a request**:

```typescript
const controller = new AbortController();

const resultPromise = client.callTool({ name: 'slow-tool', arguments: {} }, CallToolResultSchema, { signal: controller.signal });

// Cancel after 5 seconds:
setTimeout(() => controller.abort('User cancelled'), 5000);
```

**Server handler responding to cancellation**:

```typescript
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    for (let i = 0; i < 100; i++) {
        if (extra.signal.aborted) {
            return { content: [{ type: 'text', text: 'Cancelled' }], isError: true };
        }
        await doWork();
    }
    return { content: [{ type: 'text', text: 'Done' }] };
});
```

## Pagination

All list methods (`listTools`, `listPrompts`, `listResources`, `listResourceTemplates`) support cursor-based pagination. Pass `cursor` from the previous response's `nextCursor` to fetch the next page.

```typescript
let cursor: string | undefined;
const allTools: Tool[] = [];

do {
    const result = await client.listTools({ cursor });
    allTools.push(...result.tools);
    cursor = result.nextCursor;
} while (cursor);
```

The same pattern applies to `listPrompts`, `listResources`, and `listResourceTemplates`.

## Capability negotiation

Both client and server declare their capabilities during the `initialize` handshake. The SDK enforces these — attempting to use an undeclared capability throws an error.

**Client capabilities** are set at construction time:

```typescript
const client = new Client(
    { name: 'my-client', version: '1.0.0' },
    {
        capabilities: {
            roots: { listChanged: true },
            sampling: {},
            elicitation: { form: {} }
        }
    }
);
```

After connecting, inspect what the server supports:

```typescript
await client.connect(transport);

const caps = client.getServerCapabilities();
if (caps?.tools) {
    const tools = await client.listTools();
}
if (caps?.resources?.subscribe) {
    // server supports resource subscriptions
}
```

**Server capabilities** are inferred from registered handlers. When using `McpServer`, capabilities are set automatically based on what you register (tools, resources, prompts). With the low-level `Server`, you declare them in the constructor.

## Protocol version negotiation

The SDK automatically negotiates protocol versions during `initialize`. The client sends `LATEST_PROTOCOL_VERSION` and the server responds with the highest mutually supported version.

Supported versions are defined in `SUPPORTED_PROTOCOL_VERSIONS` (currently `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07`). If the server responds with an unsupported version, the client throws an error.

Version negotiation is handled automatically by `client.connect()`. After connecting, you can inspect the result:

```typescript
await client.connect(transport);

const serverVersion = client.getServerVersion();
// { name: 'my-server', version: '1.0.0' }

const serverCaps = client.getServerCapabilities();
// { tools: { listChanged: true }, resources: { subscribe: true }, ... }
```

## JSON Schema 2020-12

MCP uses JSON Schema 2020-12 for tool input and output schemas. When using `McpServer` with Zod, schemas are converted to JSON Schema automatically:

```typescript
server.registerTool(
    'calculate',
    {
        description: 'Add two numbers',
        inputSchema: { a: z.number(), b: z.number() }
    },
    async ({ a, b }) => ({
        content: [{ type: 'text', text: String(a + b) }]
    })
);
```

With the low-level `Server`, you provide JSON Schema directly:

```typescript
{
  name: 'calculate',
  inputSchema: {
    type: 'object',
    properties: {
      a: { type: 'number' },
      b: { type: 'number' }
    },
    required: ['a', 'b']
  }
}
```

The SDK validates tool outputs against `outputSchema` (when provided) using a pluggable JSON Schema validator. The default validator uses Ajv; a Cloudflare Workers-compatible alternative is available via `CfWorkerJsonSchemaValidator`.
