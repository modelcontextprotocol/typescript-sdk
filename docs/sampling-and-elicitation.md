## Sampling

MCP servers can request LLM completions from connected clients that support the sampling capability. This lets your tools offload summarisation or generation to the client’s model.

For a runnable server that combines tools, logging and tasks, see:

- `src/examples/server/toolWithSampleServer.ts`

In practice you will:

- Declare the sampling capability on the client.
- Call `server.server.createMessage(...)` from within a tool handler.
- Return the model’s response as structured content and/or text.

Refer to the MCP spec’s sampling section for full request/response details.

## Form elicitation

Form elicitation lets a tool ask the user for additional, **non‑sensitive** information via a schema‑driven form. The server sends a schema and message, and the client is responsible for collecting and returning the data.

Runnable example:

- Server: `src/examples/server/elicitationFormExample.ts`
- Client‑side handling: `src/examples/client/simpleStreamableHttp.ts`

The `simpleStreamableHttp` server also includes a `collect-user-info` tool that demonstrates how to drive elicitation from a tool and handle the response.

## URL elicitation

URL elicitation is designed for sensitive data and secure web‑based flows (e.g., collecting an API key, confirming a payment, or doing third‑party OAuth). Instead of returning form data, the server asks the client to open a URL and the rest of the flow happens in the browser.

Runnable example:

- Server: `src/examples/server/elicitationUrlExample.ts`
- Client: `src/examples/client/elicitationUrlExample.ts`

Key points:

- Use `mode: 'url'` when calling `server.server.elicitInput(...)`.
- Implement a client‑side handler for `ElicitRequestSchema` that:
    - Shows the full URL and reason to the user.
    - Asks for explicit consent.
    - Opens the URL in the system browser.

Sensitive information **must not** be collected via form elicitation; always use URL elicitation or out‑of‑band flows for secrets.
