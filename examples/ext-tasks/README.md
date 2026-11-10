# ext-tasks

A minimal server for the [MCP Tasks extension](https://github.com/modelcontextprotocol/ext-tasks) (`io.modelcontextprotocol/tasks`), everything in-process. `TasksExtension` over an `InMemoryTaskStore` serves the wire; the work behind the one tool, `bake_cake`, is a plain async function driven by timers that reports progress, asks the client which frosting to use (`input_required`), and honours cancellation between steps.

The client installs `TasksClientExtension`, calls the tool, follows the task with `waitFor` (answering the frosting question through `tasks/update` on the way), then starts a second task and cancels it while it waits for input.

```bash
pnpm tsx examples/ext-tasks/client.ts                        # stdio, spawns the server
pnpm tsx examples/ext-tasks/server.ts --http --port 3000     # or serve over HTTP …
pnpm tsx examples/ext-tasks/client.ts --http http://127.0.0.1:3000/mcp
```

Modern era only: task handles and the `tasks/*` methods ride the 2026-07-28 per-request capabilities envelope.
