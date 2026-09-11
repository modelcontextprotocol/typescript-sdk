---
shape: how-to
---

# Tasks

Server-side [MCP Tasks extension](https://github.com/modelcontextprotocol/ext-tasks) (`io.modelcontextprotocol/tasks`) with a pluggable execution engine.

`registerTask` is `registerTool` for long-running work: the handler runs as a replayable workflow (`step.do`, `step.sleep`, `step.elicit`, `step.status`, `step.offer`), and the extension's `tasks/get`, `tasks/update` and `tasks/cancel` methods route to per-task state that outlives the request that created it.

```ts
import { McpServer } from '@modelcontextprotocol/server';
import { InMemoryTaskEngine, installTasks } from '@modelcontextprotocol/server/ext/tasks';
import * as z from 'zod/v4';

const engine = new InMemoryTaskEngine();

export function createServer() {
    const server = new McpServer({ name: 'report-server', version: '1.0.0' });
    const tasks = installTasks(server, { engine });

    tasks.registerTask('send_report', { description: 'Compile and send a report', inputSchema: z.object({ to: z.string() }) }, async (input, step) => {
        const report = await step.do('fetch-data', () => fetchReportData(input.to));
        await step.status(`compiled ${report.pages} pages`);
        await step.sleep('cool-off', '5s');
        await step.do('send', { retries: { limit: 10 } }, () => sendReport(input.to, report));
        return { content: [{ type: 'text', text: `report sent to ${input.to}` }] };
    });

    return server;
}
```

A `tools/call` of `send_report` from a client that declared the extension answers a task handle (`resultType: "task"`) immediately. The handler then runs on the engine; `tasks/get` polls it, `tasks/update` answers a `step.elicit`, `tasks/cancel` stops it at the next step.

## Two seams

Handlers never touch an engine directly. Two interfaces keep them engine-invariant:

| Seam        | Interface     | Who calls it                                                                     |
| ----------- | ------------- | -------------------------------------------------------------------------------- |
| **control** | `TaskEngine`  | the `tasks/*` request handlers and the task tool: create / get / update / cancel |
| **step**    | `StepJournal` | the replay-aware `Step` API while a handler runs                                 |

`InMemoryTaskEngine` implements both in-process and is the reference: task records and step journals in a `Map`, one timer per task computed from the rows, handlers run through the attached executor. State does not survive the process.

A durable engine implements the same two interfaces and lives outside the SDK: `TaskEngine` over a database or durable-execution runtime, `StepJournal` over its journal rows, and either `attach`es the executor (`createTaskExecutor(tasks)`) to run handlers in-process or builds one where the handlers run. Swapping engines changes the `installTasks` call and nothing else.

## Step API

Step names are journal keys, unique per task. All side effects belong inside `step.do`; the handler body re-runs from the top on every resume, with completed steps returning their persisted results.

- `step.do(name, [config], fn)` — journaled closure with per-step retries (`{ retries: { limit, baseDelayMs, maxDelayMs }, timeoutMs }`). Throw `NonRetryableError` to skip retries. Results must be JSON-serializable.
- `step.sleep(name, "5m" | ms)` / `step.sleepUntil(name, when)` — durable sleep; suspends the run, the engine resumes it.
- `step.elicit(name, inputRequest, [{ timeoutMs }])` — moves the task to `input_required` and suspends until `tasks/update` answers `name` (or the deadline passes, resolving `{ outcome: "timed_out" }`).
- `step.offer(key, inputRequest)` + `step.checkInput(name, key)` — a standing, non-blocking input channel: the task stays `working`; an answer wakes it.
- `step.status(message)` — writes `statusMessage` for pollers. The handler is its only writer.

## Wire notes

- The extension is served on the 2026-07-28 revision. The task tool is advertised as a normal tool without `outputSchema`; the encode seam forwards `resultType: "task"` for `tools/call` verbatim.
- A request that does not declare `io.modelcontextprotocol/tasks` in its client capabilities is refused with `-32021`. For `tools/call` the SDK's tool dispatch surfaces that refusal as an `isError` tool result.
- `tasks/update`'s `inputResponses` shares its name with the multi-round-trip retry field: the protocol layer lifts it out of the params and the handler reads it back from `ctx.mcpReq.inputResponses`.
- Serving `tasks/get` and `tasks/cancel` needs the explicit-schema era-gate exemption from typescript-sdk#2599 (those names were 2025-11-25 core methods).
- The SDK `Client` rejects `resultType: "task"` on `tools/call` (typescript-sdk#2637); the requester half of the extension is `@modelcontextprotocol/ext-tasks`.
