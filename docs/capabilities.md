## Sampling

MCP servers can request LLM completions from connected clients that support the sampling capability. This lets your tools offload summarisation or generation to the client’s model.

For a runnable server that combines tools, logging and tasks, see:

- [`toolWithSampleServer.ts`](../examples/server/src/toolWithSampleServer.ts)

In practice you will:

- Declare the sampling capability on the client.
- Call `server.server.createMessage(...)` from within a tool handler.
- Return the model’s response as structured content and/or text.

Refer to the MCP spec’s sampling section for full request/response details.

## Elicitation

### Form elicitation

Form elicitation lets a tool ask the user for additional, **non‑sensitive** information via a schema‑driven form. The server sends a schema and message, and the client is responsible for collecting and returning the data.

Runnable example:

- Server: [`elicitationFormExample.ts`](../examples/server/src/elicitationFormExample.ts)
- Client‑side handling: [`simpleStreamableHttp.ts`](../examples/client/src/simpleStreamableHttp.ts)

The `simpleStreamableHttp` server also includes a `collect-user-info` tool that demonstrates how to drive elicitation from a tool and handle the response.

### URL elicitation

URL elicitation is designed for sensitive data and secure web‑based flows (e.g., collecting an API key, confirming a payment, or doing third‑party OAuth). Instead of returning form data, the server asks the client to open a URL and the rest of the flow happens in the browser.

Runnable example:

- Server: [`elicitationUrlExample.ts`](../examples/server/src/elicitationUrlExample.ts)
- Client: [`elicitationUrlExample.ts`](../examples/client/src/elicitationUrlExample.ts)

Key points:

- Use `mode: 'url'` when calling `server.server.elicitInput(...)`.
- Implement a client‑side handler for `ElicitRequestSchema` that:
    - Shows the full URL and reason to the user.
    - Asks for explicit consent.
    - Opens the URL in the system browser.

Sensitive information **must not** be collected via form elicitation; always use URL elicitation or out‑of‑band flows for secrets.

## Task-based execution (experimental)

Task-based execution enables “call-now, fetch-later” patterns for long-running operations. Instead of returning a result immediately, a tool creates a task that can be polled or resumed later.

The APIs live under the experimental `.experimental.tasks` namespace and may change without notice.

### Server-side concepts

On the server you will:

- Provide a `TaskStore` implementation that persists task metadata and results.
- Enable the `tasks` capability when constructing the server.
- Register tools with `server.experimental.tasks.registerToolTask(...)`.

For a runnable example that uses the in-memory store shipped with the SDK, see:

- [`toolWithSampleServer.ts`](../examples/server/src/toolWithSampleServer.ts)
- `packages/core/src/experimental/tasks/stores/in-memory.ts`

### Client-side usage

On the client, you use:

- `client.experimental.tasks.callToolStream(...)` to start a tool call that may create a task and emit status updates over time.
- `client.getTask(...)` and `client.getTaskResult(...)` to check status and fetch results after reconnecting.

The interactive client in:

- [`simpleStreamableHttp.ts`](../examples/client/src/simpleStreamableHttp.ts)

includes commands to demonstrate calling tools that support tasks and handling their lifecycle.

See the MCP spec’s tasks section and the example server/client above for a full walkthrough of the task status lifecycle and TTL handling.
