---
"@modelcontextprotocol/core": minor
"@modelcontextprotocol/server": minor
"@modelcontextprotocol/client": minor
---

feat(tasks): add task streaming with partial result notifications

Implements SEP-0000 (Task Streaming — Partial Results for Long-Running Operations). Adds `notifications/tasks/partial` — a new JSON-RPC notification type that enables servers to push incremental content chunks to clients while a task is in progress.

**Core:**
- `TaskPartialNotificationParamsSchema` and `TaskPartialNotificationSchema` Zod schemas
- Extended `ServerTasksCapabilitySchema` and `ClientTasksCapabilitySchema` with `streaming.partial`
- Extended `ToolExecutionSchema` with optional `streamPartial` boolean
- Hand-written conformance types in `spec.types.ts`

**Server:**
- `ExperimentalMcpServerTasks.sendTaskPartial(taskId, content, seq)` — sends partial notifications with Zod validation, terminal status check, and capability gating
- `ExperimentalMcpServerTasks.createPartialEmitter(taskId)` — returns a function with auto-incrementing seq for use in background work
- Automatic `tasks.streaming.partial` capability declaration when `registerToolTask` is called with `streamPartial: true`

**Client:**
- `ExperimentalClientTasks.subscribeTaskPartials(taskId, handler)` — subscribes to partial notifications with automatic seq-based ordering, duplicate detection, and gap warning
