## Task-based execution (experimental)

Task-based execution enables “call-now, fetch-later” patterns for long-running
operations. Instead of returning a result immediately, a tool creates a task
that can be polled or resumed later.

The APIs live under the experimental `.experimental.tasks` namespace and may
change without notice.

### Server-side concepts

On the server you will:

- Provide a `TaskStore` implementation that persists task metadata and results.
- Enable the `tasks` capability when constructing the server.
- Register tools with `server.experimental.tasks.registerToolTask(...)`.

For a runnable example that uses the in-memory store shipped with the SDK, see:

- `src/examples/server/toolWithSampleServer.ts`
- `src/experimental/tasks/stores/in-memory.ts`

### Client-side usage

On the client, you use:

- `client.experimental.tasks.callToolStream(...)` to start a tool call that may
  create a task and emit status updates over time.
- `client.getTask(...)` and `client.getTaskResult(...)` to check status and
  fetch results after reconnecting.

The interactive client in:

- `src/examples/client/simpleStreamableHttp.ts`

includes commands to demonstrate calling tools that support tasks and handling
their lifecycle.

See the MCP spec’s tasks section and the example server/client above for a full
walkthrough of the task status lifecycle and TTL handling.



