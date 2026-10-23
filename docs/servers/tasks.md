---
shape: how-to
---

# Tasks (extension)

The [MCP Tasks extension](https://github.com/modelcontextprotocol/ext-tasks) (`io.modelcontextprotocol/tasks`) lets a tool answer with a **task handle** instead of blocking on work that takes minutes: the client polls `tasks/get`, answers `tasks/update`, and stops with `tasks/cancel`. `@modelcontextprotocol/server/ext/tasks` is the server side of that wire, as a [server extension](../advanced/extensions.md). It owns the protocol; you own the task's state and its execution, behind a `TaskStore`.

## Install the extension

`TasksExtension` takes the store. `InMemoryTaskStore` is the in-process reference; a persistent store implements the same four methods.

```ts
import { McpServer } from '@modelcontextprotocol/server';
import { InMemoryTaskStore, TasksExtension } from '@modelcontextprotocol/server/ext/tasks';

const store = new InMemoryTaskStore();
const tasks = new TasksExtension(store);

const server = new McpServer({ name: 'report-server', version: '1.0.0' }, { extensions: [tasks] });
```

The server advertises `io.modelcontextprotocol/tasks` under `capabilities.extensions` and serves `tasks/get`, `tasks/update` and `tasks/cancel`.

## Answer a tool call with a task

Inside a tool handler, `tasks.create(ctx)` creates the task in the store, bound to the request's principal, and returns the handle the handler answers with. The work itself is yours to start however your server runs things — here, an async function driving the in-memory store's writer handle.

```ts
import * as z from 'zod/v4';

server.registerTool('send_report', { inputSchema: z.object({ to: z.string() }) }, async ({ to }, ctx) => {
    const task = await tasks.create(ctx, { ttlMs: 3_600_000 });
    void sendReport(store.handle(task.taskId), to);
    return task;
});

async function sendReport(handle: TaskHandle, to: string) {
    await handle.status('compiling');
    const report = await compile(to);
    const answers = await handle.requireInput({
        approve: { method: 'elicitation/create', params: { message: `send ${report.pages} pages to ${to}?`, mode: 'form', requestedSchema: { type: 'object', properties: {} } } }
    });
    if (answers.approve?.action !== 'accept' || handle.signal.aborted) return handle.complete({ content: [{ type: 'text', text: 'not sent' }] });
    await deliver(report, to);
    await handle.complete({ content: [{ type: 'text', text: `report sent to ${to}` }] });
}
```

On the wire the tool answers a flat `CreateTaskResult` (`resultType: "task"`). `requireInput` moves the task to `input_required` and resolves once `tasks/update` has answered every key. `tasks/cancel` aborts `handle.signal`; a later `complete` or `fail` is ignored.

## Bring your own store

`TaskStore` is four methods over JSON:

| Method                                    | Contract                                                                                                                      |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `create(params)`                          | Durably create; MUST NOT resolve before a following `get` would succeed. `params.context` is yours (tool name, workflow id…). |
| `get(taskId, access?)`                    | The `DetailedTask` snapshot, or `undefined` for unknown, expired, or foreign-principal tasks.                                 |
| `update(taskId, inputResponses, access?)` | Deliver answers; `false` when the task is not found. Unknown keys are ignored, partial answers accepted.                      |
| `cancel(taskId, access?)`                 | Cooperative; resolves on acknowledgement. Idempotent on terminal tasks.                                                       |

How the work behind a task runs — a queue, a workflow engine, a durable-execution runtime — is invisible to the SDK. The store is also where a writer API lives if your execution needs one; `InMemoryTaskStore.handle` is the reference shape.

## Wire notes

- The extension is served on the 2026-07-28 revision. Task tools are ordinary tools without `outputSchema`; the result encoder forwards `resultType: "task"` for `tools/call` verbatim.
- A request that does not declare `io.modelcontextprotocol/tasks` in its client capabilities is refused with `-32021` — from `tasks.create`, from the `tasks/*` methods, and by the extension's `tools/call` middleware for any handle minted some other way.
- `tasks/update`'s `inputResponses` shares its name with the multi-round-trip retry field: the protocol layer lifts it out of the params and the extension reads it back from `ctx.mcpReq.inputResponses`.
- The SDK `Client` rejects `resultType: "task"` on `tools/call` (typescript-sdk#2637); the requester half of the extension is `@modelcontextprotocol/ext-tasks`.
- `notifications/tasks` over `subscriptions/listen` is not implemented (typescript-sdk#2569); polling only.

## Recap

- `new TasksExtension(store)` in `ServerOptions.extensions` serves the extension.
- `tasks.create(ctx, options?)` in a tool handler returns the task handle to answer with.
- `TaskStore` is create / get / update / cancel; `InMemoryTaskStore` is the reference and adds a writer `handle`.
- Execution is the server's; the SDK only defines the API shape.
