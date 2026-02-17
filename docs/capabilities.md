## Sampling

MCP servers can request LLM completions from connected clients that support the sampling capability. This lets your tools offload summarisation or generation to the client’s model.

For a runnable server that combines tools, logging and tasks, see:

- [`toolWithSampleServer.ts`](../src/examples/server/toolWithSampleServer.ts)

In practice you will:

- Declare the sampling capability on the client.
- Call `server.server.createMessage(...)` from within a tool handler.
- Return the model’s response as structured content and/or text.

Refer to the MCP spec’s sampling section for full request/response details.

## Elicitation

### Form elicitation

Form elicitation lets a tool ask the user for additional, **non‑sensitive** information via a schema‑driven form. The server sends a schema and message, and the client is responsible for collecting and returning the data.

Runnable example:

- Server: [`elicitationFormExample.ts`](../src/examples/server/elicitationFormExample.ts)
- Client‑side handling: [`simpleStreamableHttp.ts`](../src/examples/client/simpleStreamableHttp.ts)

The `simpleStreamableHttp` server also includes a `collect-user-info` tool that demonstrates how to drive elicitation from a tool and handle the response.

#### Schema validation

Elicitation schemas support validation constraints on each field. The server validates responses automatically against the `requestedSchema` using the SDK's JSON Schema validator.

```typescript
const result = await server.server.elicitInput({
    mode: 'form',
    message: 'Enter your details:',
    requestedSchema: {
        type: 'object',
        properties: {
            email: {
                type: 'string',
                title: 'Email',
                format: 'email',
                minLength: 5
            },
            age: {
                type: 'integer',
                title: 'Age',
                minimum: 0,
                maximum: 150
            }
        },
        required: ['email']
    }
});
```

String fields support `minLength`, `maxLength`, and `format` (`'email'`, `'uri'`, `'date'`, `'date-time'`). Number fields support `minimum` and `maximum`.

#### Default values

Schema properties can include `default` values. When the client declares the `applyDefaults` capability, the SDK automatically fills in defaults for fields the user doesn't provide.

> **Note:** `applyDefaults` is a TypeScript SDK extension — it is not part of the MCP protocol specification.

```typescript
// Client declares applyDefaults:
const client = new Client(
  { name: 'my-client', version: '1.0.0' },
  { capabilities: { elicitation: { form: { applyDefaults: true } } } }
);

// Server schema with defaults:
requestedSchema: {
  type: 'object',
  properties: {
    newsletter: { type: 'boolean', title: 'Newsletter', default: false },
    theme: { type: 'string', title: 'Theme', default: 'dark' }
  }
}
```

#### Enum values

Elicitation schemas support several enum patterns for single-select and multi-select fields:

```typescript
requestedSchema: {
  type: 'object',
  properties: {
    // Simple enum (untitled options)
    color: {
      type: 'string',
      title: 'Favorite Color',
      enum: ['red', 'green', 'blue'],
      default: 'blue'
    },
    // Titled enum with display labels
    priority: {
      type: 'string',
      title: 'Priority',
      oneOf: [
        { const: 'low', title: 'Low Priority' },
        { const: 'medium', title: 'Medium Priority' },
        { const: 'high', title: 'High Priority' }
      ]
    },
    // Multi-select
    tags: {
      type: 'array',
      title: 'Tags',
      items: { type: 'string', enum: ['frontend', 'backend', 'docs'] },
      minItems: 1,
      maxItems: 3
    }
  }
}
```

For a full example with validation, defaults, and enums, see [`elicitationFormExample.ts`](../src/examples/server/elicitationFormExample.ts).

### URL elicitation

URL elicitation is designed for sensitive data and secure web‑based flows (e.g., collecting an API key, confirming a payment, or doing third‑party OAuth). Instead of returning form data, the server asks the client to open a URL and the rest of the flow happens in the browser.

Runnable example:

- Server: [`elicitationUrlExample.ts`](../src/examples/server/elicitationUrlExample.ts)
- Client: [`elicitationUrlExample.ts`](../src/examples/client/elicitationUrlExample.ts)

Key points:

- Use `mode: 'url'` when calling `server.server.elicitInput(...)`.
- Implement a client‑side handler for `ElicitRequestSchema` that:
    - Shows the full URL and reason to the user.
    - Asks for explicit consent.
    - Opens the URL in the system browser.

Sensitive information **must not** be collected via form elicitation; always use URL elicitation or out‑of‑band flows for secrets.

#### Complete notification

When a URL elicitation flow finishes (the user completes the browser-based action), the server sends a `notifications/elicitation/complete` notification to the client. This tells the client the out-of-band flow is done and any pending UI can be dismissed.

Use `createElicitationCompletionNotifier` on the low-level server to create a callback that sends this notification:

```typescript
// Create a notifier for a specific elicitation:
const notifyComplete = server.server.createElicitationCompletionNotifier('setup-123');

// Later, when the browser flow completes (e.g. via webhook):
await notifyComplete();
// Client receives: { method: 'notifications/elicitation/complete', params: { elicitationId: 'setup-123' } }
```

See [`elicitationUrlExample.ts`](../src/examples/server/elicitationUrlExample.ts) for a full working example.

## Task-based execution (experimental)

Task-based execution enables “call-now, fetch-later” patterns for long-running operations. Instead of returning a result immediately, a tool creates a task that can be polled or resumed later.

The APIs live under the experimental `.experimental.tasks` namespace and may change without notice.

### Server-side concepts

On the server you will:

- Provide a `TaskStore` implementation that persists task metadata and results.
- Enable the `tasks` capability when constructing the server.
- Register tools with `server.experimental.tasks.registerToolTask(...)`.

For a runnable example that uses the in-memory store shipped with the SDK, see:

- [`toolWithSampleServer.ts`](../src/examples/server/toolWithSampleServer.ts)
- `src/experimental/tasks/stores/in-memory.ts`

### Client-side usage

On the client, you use:

- `client.experimental.tasks.callToolStream(...)` to start a tool call that may create a task and emit status updates over time.
- `client.experimental.tasks.getTask(...)` and `client.experimental.tasks.getTaskResult(...)` to check status and fetch results after reconnecting.

The interactive client in:

- [`simpleStreamableHttp.ts`](../src/examples/client/simpleStreamableHttp.ts)

includes commands to demonstrate calling tools that support tasks and handling their lifecycle.

See the MCP spec’s tasks section and the example server/client above for a full walkthrough of the task status lifecycle and TTL handling.
