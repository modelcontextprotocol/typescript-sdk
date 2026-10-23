---
shape: how-to
---

# Tasks (extension)

The [MCP Tasks extension](https://github.com/modelcontextprotocol/ext-tasks) (`io.modelcontextprotocol/tasks`) lets a server answer a tool call with a **task handle** instead of blocking: you poll `tasks/get`, answer `tasks/update`, and stop with `tasks/cancel`. `@modelcontextprotocol/client/ext/tasks` is the client side of that wire, as a [client extension](../advanced/extensions.md). The server side is [Tasks (extension)](../servers/tasks.md).

## Install the extension

One extension instance serves one client; pass it at construction.

```ts
import { Client } from '@modelcontextprotocol/client';
import { TasksClientExtension } from '@modelcontextprotocol/client/ext/tasks';

const tasks = new TasksClientExtension();
const client = new Client({ name: 'report-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' }, extensions: [tasks] });
await client.connect(transport);
```

The client declares `io.modelcontextprotocol/tasks` in the capabilities envelope of every request — the server refuses task handles to clients that do not — and accepts `resultType: "task"` on `tools/call`, which the plain `client.callTool` cannot describe.

## Call a tool that may become a task

`tasks.callTool` returns a discriminated outcome: a task handle to follow, or the ordinary result for tools that answered synchronously.

```ts
const outcome = await tasks.callTool({ name: 'send_report', arguments: { to: 'ops' } });
if (outcome.kind === 'result') {
    console.log(outcome.result.content);
} else {
    console.log(outcome.task.taskId, outcome.task.status, outcome.task.pollIntervalMs);
}
```

## Poll to the end

`waitFor` polls `tasks/get` at the server's suggested `pollIntervalMs` until the task is terminal. Every snapshot passes through `onUpdate`, which is where an `input_required` task gets answered.

```ts
const done = await tasks.waitFor(outcome.task.taskId, {
    signal: controller.signal,
    onUpdate: async task => {
        if (task.status === 'input_required') {
            const answers = await askUser(task.inputRequests);
            await tasks.update(task.taskId, answers);
        }
    }
});

switch (done.status) {
    case 'completed':
        console.log(done.result);
        break;
    case 'failed':
        console.error(done.error);
        break;
    case 'cancelled':
        break;
}
```

Aborting the signal stops polling and nothing else. Cancelling the task is a separate, cooperative call: `await tasks.cancel(taskId)` resolves on acknowledgement, and the task may still settle `completed` or `failed`.

## The raw methods

| Method                                 | Wire           | Returns                                                               |
| -------------------------------------- | -------------- | --------------------------------------------------------------------- |
| `tasks.get(taskId)`                    | `tasks/get`    | The `DetailedTask` snapshot: result, error, or input requests inlined |
| `tasks.update(taskId, inputResponses)` | `tasks/update` | Resolves on acknowledgement; partial answers are accepted             |
| `tasks.cancel(taskId)`                 | `tasks/cancel` | Resolves on acknowledgement                                           |

Each takes the usual `RequestOptions` (`signal`, `timeout`) as a last argument.

## Recap

- `new TasksClientExtension()` in `ClientOptions.extensions`; one instance per client.
- `tasks.callTool(params)` yields `{ kind: 'task', task }` or `{ kind: 'result', result }`.
- `tasks.waitFor(taskId, { onUpdate, signal })` polls at the server's interval to a terminal snapshot.
- `get`, `update`, `cancel` are the extension's three methods, one to one.
