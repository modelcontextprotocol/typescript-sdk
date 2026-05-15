# Remove Tasks Feature — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the entire Tasks feature (experimental task-augmented execution, TaskManager, task stores, task schemas) from the MCP TypeScript SDK — as if it never existed.

**Architecture:** Tasks is woven into four layers: Zod schemas/types, the Protocol class (via TaskManager), Server/Client classes (experimental accessors + capability wiring), and barrel exports. We delete bottom-up: schemas/types first, then core TaskManager, then Server/Client integrations, then exports and tests. Each task produces a buildable (but possibly failing-tests) state; the final task verifies everything passes.

**Tech Stack:** TypeScript, Zod v4, vitest, pnpm workspaces

---

## File Map

### Files/Directories to DELETE entirely

```
packages/core/src/experimental/tasks/           (helpers.ts, interfaces.ts, stores/inMemory.ts)
packages/core/src/experimental/index.ts          (only re-exports tasks)
packages/server/src/experimental/tasks/          (index.ts, interfaces.ts, server.ts, mcpServer.ts)
packages/server/src/experimental/index.ts        (only re-exports tasks)
packages/client/src/experimental/tasks/          (client.ts, client.examples.ts)
packages/client/src/experimental/index.ts        (only re-exports tasks)
packages/core/src/shared/taskManager.ts          (915 lines — TaskManager, NullTaskManager)
test/integration/test/experimental/tasks/        (task.test.ts, taskListing.test.ts)
test/integration/test/taskLifecycle.test.ts
packages/core/test/experimental/                 (inMemory.test.ts)
test/helpers/src/helpers/tasks.ts
examples/server/src/simpleTaskInteractive.ts
examples/server/src/README-simpleTaskInteractive.md
examples/client/src/simpleTaskInteractiveClient.ts
.changeset/extract-task-manager.md
.changeset/fix-failed-task-result-retrieval.md
.changeset/fix-task-session-isolation.md
```

### Files to MODIFY

```
packages/core/src/types/schemas.ts               — remove ~20 task schemas, TaskAugmentedRequestParamsSchema, ToolExecutionSchema
packages/core/src/types/spec.types.ts            — remove task types, TaskAugmentedRequestParams, ToolExecution
packages/core/src/types/types.ts                 — remove task type aliases
packages/core/src/types/specTypeSchema.ts        — remove task schema names from allowlist
packages/core/src/types/guards.ts                — remove isTaskAugmentedRequestParams
packages/core/src/types/constants.ts             — remove RELATED_TASK_META_KEY
packages/core/src/shared/protocol.ts             — remove TaskManager integration entirely
packages/core/src/shared/responseMessage.ts      — remove TaskStatusMessage, TaskCreatedMessage
packages/core/src/index.ts                       — remove taskManager exports, experimental re-export
packages/core/src/exports/public/index.ts        — remove task exports
packages/server/src/server/server.ts             — remove task capability wiring, experimental getter
packages/server/src/server/mcp.ts                — remove task handling logic, experimental getter
packages/server/src/index.ts                     — remove experimental task exports
packages/client/src/client/client.ts             — remove task capability wiring, experimental getter
packages/client/src/index.ts                     — remove experimental task exports
packages/core/test/shared/protocol.test.ts       — remove task-related tests
test/helpers/src/index.ts                        — remove tasks export
examples/server/src/simpleStreamableHttp.ts      — remove task store config and registerToolTask
docs/migration.md                                — remove task-related sections
docs/migration-SKILL.md                          — remove task-related sections
CLAUDE.md                                        — remove task references
```

---

### Task 1: Delete task source directories and standalone files

**Files:**
- Delete: `packages/core/src/experimental/tasks/` (entire directory)
- Delete: `packages/core/src/experimental/index.ts`
- Delete: `packages/server/src/experimental/tasks/` (entire directory)
- Delete: `packages/server/src/experimental/index.ts`
- Delete: `packages/client/src/experimental/tasks/` (entire directory)
- Delete: `packages/client/src/experimental/index.ts`
- Delete: `packages/core/src/shared/taskManager.ts`

- [ ] **Step 1: Delete core experimental tasks directory and its barrel**

```bash
rm -rf packages/core/src/experimental/tasks
rm packages/core/src/experimental/index.ts
rmdir packages/core/src/experimental   # should be empty now
```

- [ ] **Step 2: Delete server experimental tasks directory and its barrel**

```bash
rm -rf packages/server/src/experimental/tasks
rm packages/server/src/experimental/index.ts
rmdir packages/server/src/experimental
```

- [ ] **Step 3: Delete client experimental tasks directory and its barrel**

```bash
rm -rf packages/client/src/experimental/tasks
rm packages/client/src/experimental/index.ts
rmdir packages/client/src/experimental
```

- [ ] **Step 4: Delete TaskManager**

```bash
rm packages/core/src/shared/taskManager.ts
```

---

### Task 2: Remove task schemas from `schemas.ts`

**Files:**
- Modify: `packages/core/src/types/schemas.ts`

Remove these schemas and all their JSDoc comments. The schemas are spread across the file, so use line references below.

- [ ] **Step 1: Remove `RELATED_TASK_META_KEY` import and task-related schemas at top of file**

In `schemas.ts`, remove the `RELATED_TASK_META_KEY` import from the `constants.js` import line (line 3). Then remove:

- `TaskCreationParamsSchema` (lines ~33–43)
- `TaskMetadataSchema` (lines ~45–47)
- `RelatedTaskMetadataSchema` (lines ~49–55)
- The `[RELATED_TASK_META_KEY]` field from `BaseRequestParamsSchema` (line ~65)
- `TaskAugmentedRequestParamsSchema` (lines ~79–91) — this is the schema that adds `task` to requests

- [ ] **Step 2: Remove task capability schemas**

Remove:
- `ClientTasksCapabilitySchema` (lines ~335–368)
- `ServerTasksCapabilitySchema` (lines ~372–410)
- The `tasks` field from `ClientCapabilitiesSchema` (line ~442)
- The `tasks` field from `ServerCapabilitiesSchema` (line ~522)

- [ ] **Step 3: Remove task status, task, and task-related request/result schemas**

Remove:
- `TaskStatusSchema` (line ~620)
- `TaskSchema` (lines ~628–648)
- `CreateTaskResultSchema` (lines ~652–656)
- `TaskStatusNotificationParamsSchema` (line ~659)
- `TaskStatusNotificationSchema` (lines ~664–668)
- `GetTaskRequestSchema` (lines ~672–678)
- `GetTaskResultSchema` (line ~682 — aliases TaskSchema)
- `GetTaskPayloadRequestSchema` (lines ~687–693)
- `GetTaskPayloadResultSchema` (line ~697 — aliases ResultSchema)
- `ListTasksRequestSchema` (lines ~705–709)
- `ListTasksResultSchema` (lines ~712–716)
- `CancelTaskRequestSchema` (lines ~719–725)
- `CancelTaskResultSchema` (line ~729 — aliases EmptyResultSchema)

- [ ] **Step 4: Remove `ToolExecutionSchema` and `execution` from `ToolSchema`**

`ToolExecutionSchema` (lines ~1288–1298) only contains `taskSupport` — remove the entire schema.

In `ToolSchema` (line ~1341), remove the `execution: ToolExecutionSchema.optional()` field.

- [ ] **Step 5: Change request params schemas to extend `BaseRequestParamsSchema` instead of `TaskAugmentedRequestParamsSchema`**

Change these lines:
- `CallToolRequestParamsSchema = TaskAugmentedRequestParamsSchema.extend({` → `CallToolRequestParamsSchema = BaseRequestParamsSchema.extend({` (line ~1412)
- `CreateMessageRequestParamsSchema = TaskAugmentedRequestParamsSchema.extend({` → `CreateMessageRequestParamsSchema = BaseRequestParamsSchema.extend({` (line ~1610)
- `ElicitRequestFormParamsSchema = TaskAugmentedRequestParamsSchema.extend({` → `ElicitRequestFormParamsSchema = BaseRequestParamsSchema.extend({` (line ~1849)
- `ElicitRequestURLParamsSchema = TaskAugmentedRequestParamsSchema.extend({` → `ElicitRequestURLParamsSchema = BaseRequestParamsSchema.extend({` (line ~1876)

- [ ] **Step 6: Remove task methods from result type mapping**

At the bottom of `schemas.ts` (lines ~2176–2179), remove:
```typescript
'tasks/get': GetTaskResultSchema,
'tasks/result': ResultSchema,
'tasks/list': ListTasksResultSchema,
'tasks/cancel': CancelTaskResultSchema
```

---

### Task 3: Remove task types from `spec.types.ts`, `types.ts`, `specTypeSchema.ts`, `guards.ts`, `constants.ts`

**Files:**
- Modify: `packages/core/src/types/spec.types.ts`
- Modify: `packages/core/src/types/types.ts`
- Modify: `packages/core/src/types/specTypeSchema.ts`
- Modify: `packages/core/src/types/guards.ts`
- Modify: `packages/core/src/types/constants.ts`

- [ ] **Step 1: Remove task types from `spec.types.ts`**

Remove:
- `TaskAugmentedRequestParams` interface (lines ~91–104) — change `CallToolRequestParams`, `CreateMessageRequestParams`, `ElicitRequestFormParams`, `ElicitRequestURLParams` to extend `RequestParams` instead
- `ClientCapabilities.tasks` field (lines ~546–578)
- `ServerCapabilities.tasks` field (lines ~672–694)
- `ToolExecution` interface (lines ~1695–1708)
- `Tool.execution` field (line ~1748)
- All types in the `/* Tasks */` section (lines ~1774–1965): `TaskStatus`, `TaskMetadata`, `RelatedTaskMetadata`, `Task`, `CreateTaskResult`, `CreateTaskResultResponse`, `GetTaskRequest`, `GetTaskResult`, `GetTaskResultResponse`, `GetTaskPayloadRequest`, `GetTaskPayloadResult`, `ListTasksRequest`, `ListTasksResult`, `CancelTaskRequest`, `CancelTaskResult`, `TaskStatusNotificationParams`, `TaskStatusNotification`
- Remove task-related JSDoc references in `CancelledNotification` (lines ~366–367, ~386)
- Remove task mention from `ErrorCode` docs (line ~284)

- [ ] **Step 2: Remove task type aliases from `types.ts`**

Remove all task-related schema imports and type aliases:
```typescript
// Remove these imports from schemas.ts:
CancelTaskRequestSchema, CancelTaskResultSchema, CreateTaskResultSchema,
GetTaskPayloadRequestSchema, GetTaskPayloadResultSchema, GetTaskRequestSchema,
GetTaskResultSchema, ListTasksRequestSchema, ListTasksResultSchema,
RelatedTaskMetadataSchema, TaskAugmentedRequestParamsSchema, TaskCreationParamsSchema,
TaskMetadataSchema, TaskSchema, TaskStatusNotificationParamsSchema,
TaskStatusNotificationSchema, TaskStatusSchema

// Remove these type aliases (lines ~190, ~235–260):
TaskAugmentedRequestParams, Task, TaskStatus, TaskCreationParams, TaskMetadata,
RelatedTaskMetadata, CreateTaskResult, TaskStatusNotificationParams,
TaskStatusNotification, GetTaskRequest, GetTaskResult, GetTaskPayloadRequest,
GetTaskPayloadResult, ListTasksRequest, ListTasksResult, CancelTaskRequest, CancelTaskResult
```

Also remove the `ToolExecution` type alias and `ToolExecutionSchema` import if present.

- [ ] **Step 3: Remove task schema names from `specTypeSchema.ts` allowlist**

Remove these entries from the `SPEC_SCHEMA_NAMES` array:
```
'CancelTaskRequestSchema', 'CancelTaskResultSchema', 'CreateTaskResultSchema',
'GetTaskPayloadRequestSchema', 'GetTaskPayloadResultSchema',
'GetTaskRequestSchema', 'GetTaskResultSchema',
'ListTasksRequestSchema', 'ListTasksResultSchema',
'RelatedTaskMetadataSchema', 'TaskSchema', 'TaskAugmentedRequestParamsSchema',
'TaskCreationParamsSchema', 'TaskMetadataSchema', 'TaskStatusSchema',
'TaskStatusNotificationSchema', 'TaskStatusNotificationParamsSchema'
```

Also remove `'ToolExecutionSchema'` if present.

- [ ] **Step 4: Remove `isTaskAugmentedRequestParams` from `guards.ts`**

Remove the import of `TaskAugmentedRequestParamsSchema` and `TaskAugmentedRequestParams`.
Remove the `isTaskAugmentedRequestParams` function (lines ~85–91).

- [ ] **Step 5: Remove `RELATED_TASK_META_KEY` from `constants.ts`**

Remove line 5: `export const RELATED_TASK_META_KEY = 'io.modelcontextprotocol/related-task';`

---

### Task 4: Remove TaskManager integration from `protocol.ts`

**Files:**
- Modify: `packages/core/src/shared/protocol.ts`

This is the most complex modification. The TaskManager intercepts request/response/notification flows.

- [ ] **Step 1: Remove task imports**

Remove from the type imports (lines 24, 33):
- `RelatedTaskMetadata`
- `TaskCreationParams`

Remove the taskManager imports (lines 49–50):
```typescript
import type { TaskContext, TaskManagerHost, TaskManagerOptions, TaskRequestOptions } from './taskManager.js';
import { NullTaskManager, TaskManager } from './taskManager.js';
```

- [ ] **Step 2: Remove `tasks` from `ProtocolOptions`**

Remove the `tasks?: TaskManagerOptions` field and its JSDoc from `ProtocolOptions` (lines ~87–94).

- [ ] **Step 3: Remove task fields from `RequestOptions`**

Remove from `RequestOptions`:
- The `task?: TaskCreationParams` field and JSDoc (lines ~140–142)
- The `relatedTask?: RelatedTaskMetadata` field and JSDoc (lines ~144–147)
- Update the `onprogress` JSDoc to remove the task-related sentence (line ~109)

- [ ] **Step 4: Remove `relatedTask` from `NotificationOptions`**

Remove the `relatedTask?: RelatedTaskMetadata` field and JSDoc from `NotificationOptions` (lines ~160–162).

- [ ] **Step 5: Remove `task?` from `BaseContext`**

Remove the `task?: TaskContext` field and its JSDoc from `BaseContext` (lines ~236–239).

Change `TaskRequestOptions` to `RequestOptions` in `BaseContext.mcpReq.send` signatures (lines ~209, ~215).

- [ ] **Step 6: Remove `_taskManager` field, constructor wiring, and `_bindTaskManager()`**

In the `Protocol` class:
- Remove `private _taskManager: TaskManager;` (line ~322)
- Remove `taskManager` getter (lines ~376–378)
- In constructor: remove the TaskManager creation lines (lines ~353–355):
  ```typescript
  this._taskManager = _options?.tasks ? new TaskManager(_options.tasks) : new NullTaskManager();
  this._bindTaskManager();
  ```
- Remove entire `_bindTaskManager()` method (lines ~380–403)
- Remove `assertTaskCapability()` abstract method declaration (lines ~785–790)
- Remove `assertTaskHandlerCapability()` abstract method declaration (lines ~792–798)

- [ ] **Step 7: Simplify `_onclose()` to remove TaskManager call**

Remove `this._taskManager.onClose();` (line ~509).

- [ ] **Step 8: Simplify `_onrequest()` to remove TaskManager delegation**

In `_onrequest()` (starting at line ~555):

Replace the TaskManager delegation block (lines ~570–631) with direct context building. The key changes:
- Remove `const taskResult = this._taskManager.processInboundRequest(...)` and all destructuring
- Use `inboundCtx.sendNotification` and `inboundCtx.sendRequest` directly in BaseContext
- Remove `taskContext` from BaseContext construction (remove `task: taskContext` at line ~631)
- Replace `routeResponse(...)` calls with direct `capturedTransport?.send(...)` — there are three places: the no-handler error path, the success path, and the error path

The simplified `_onrequest` should:
1. Build the abort controller and base context directly
2. Call the handler
3. Send responses directly through `capturedTransport?.send()`

- [ ] **Step 9: Simplify `_onresponse()` to remove TaskManager delegation**

In `_onresponse()` (starting at line ~722):

Remove:
```typescript
const taskResult = this._taskManager.processInboundResponse(response, messageId);
if (taskResult.consumed) return;
const preserveProgress = taskResult.preserveProgress;
```

And change `if (!preserveProgress)` to unconditionally delete progress handlers:
```typescript
this._progressHandlers.delete(messageId);
```

Remove the comment about "Keep progress handler alive for CreateTaskResult responses" (line ~739).

- [ ] **Step 10: Simplify `_requestWithSchema()` to remove TaskManager delegation**

In `_requestWithSchema()` (starting at line ~836):

Remove the entire TaskManager outbound block (lines ~941–964):
```typescript
const responseHandler = ...;
let outboundQueued = false;
try { const taskResult = this._taskManager.processOutboundRequest(...); ... }
```

Replace with direct transport send (the code that's currently in the `if (!outboundQueued)` block at line ~966).

- [ ] **Step 11: Simplify `notification()` to remove TaskManager delegation**

In `notification()` (starting at line ~992):

Remove the TaskManager delegation block (lines ~999–1007):
```typescript
const taskResult = await this._taskManager.processOutboundNotification(notification, options);
const queued = taskResult.queued;
const jsonrpcNotification = taskResult.queued ? undefined : taskResult.jsonrpcNotification;
if (queued) { return; }
```

Build the JSONRPC notification directly (it was previously done by TaskManager for the non-queued path). The simple version:
```typescript
const jsonrpcNotification: JSONRPCNotification = {
    jsonrpc: '2.0',
    method: notification.method,
    ...(notification.params && { params: notification.params })
};
```

Also remove `!options?.relatedTask` from the debounce guard (line ~1013).

---

### Task 5: Simplify `responseMessage.ts`

**Files:**
- Modify: `packages/core/src/shared/responseMessage.ts`

- [ ] **Step 1: Remove task message types and simplify**

Remove:
- Import of `Task` from types
- `TaskStatusMessage` interface (lines ~16–19)
- `TaskCreatedMessage` interface (lines ~27–30)
- Task references from `ResponseMessage` union type (line ~67) — becomes: `ResultMessage<T> | ErrorMessage`
- Task references from JSDoc comments throughout the file
- In `takeResult()`, the `taskCreated` and `taskStatus` cases are already handled by the fall-through — the function only returns on `result` and throws on `error`, so no code change needed there, but update the JSDoc to remove task mentions.

---

### Task 6: Clean up Server (`server.ts` and `mcp.ts`)

**Files:**
- Modify: `packages/server/src/server/server.ts`
- Modify: `packages/server/src/server/mcp.ts`

- [ ] **Step 1: Clean up `server.ts` imports**

Remove from the type imports:
- `TaskManagerOptions` (line 31)

Remove from the value imports:
- `assertClientRequestTaskCapability` (line 36)
- `assertToolsCallTaskCapability` (line 37)
- `CreateTaskResultSchema` (line 42)
- `extractTaskManagerOptions` (line 45)

Remove:
```typescript
import { ExperimentalServerTasks } from '../experimental/tasks/server.js';
```
(line 59)

- [ ] **Step 2: Remove `ServerTasksCapabilityWithRuntime` and simplify `ServerOptions`**

Remove the `ServerTasksCapabilityWithRuntime` type (line 65).

Simplify `ServerOptions.capabilities` — remove the `Omit<ServerCapabilities, 'tasks'>` and `tasks?` override (lines 71–73). Just use:
```typescript
capabilities?: ServerCapabilities;
```

- [ ] **Step 3: Remove task wiring from Server constructor**

- Remove `tasks: extractTaskManagerOptions(options?.capabilities?.tasks)` from super call (line 120) — just pass `...options`
- Remove the entire `if (options?.capabilities?.tasks)` block that strips runtime fields (lines 127–132)
- Remove `private _experimental?: { tasks: ExperimentalServerTasks };` (line 104)
- Remove the `get experimental()` getter (lines 184–191)

- [ ] **Step 4: Remove task validation from `_wrapHandler()`**

In `_wrapHandler()` for `tools/call` (lines 225–267):

Remove the `if (params.task)` block (lines 245–255) that validates `CreateTaskResult`. The method should only validate against `CallToolResultSchema`.

Also change the return type annotation on the handler from `Promise<CallToolResult | CreateTaskResult>` to `Promise<CallToolResult>` if present.

- [ ] **Step 5: Remove `assertTaskCapability()` and `assertTaskHandlerCapability()`**

Remove both methods (lines 413–418).

- [ ] **Step 6: Clean up `mcp.ts` imports**

Remove from imports:
- `CreateTaskResult` (line 8)
- `CreateTaskServerContext` (line 9)
- `ToolExecution` (line 26)

Remove:
```typescript
import type { ToolTaskHandler } from '../experimental/tasks/interfaces.js';
import { ExperimentalMcpServerTasks } from '../experimental/tasks/mcpServer.js';
```
(lines 44–45)

- [ ] **Step 7: Remove `_experimental` and experimental getter from `McpServer`**

Remove `private _experimental?: { tasks: ExperimentalMcpServerTasks };` (line 75).
Remove the `get experimental()` getter (lines 88–95).

- [ ] **Step 8: Simplify `tools/call` handler in McpServer**

In the `tools/call` handler (lines 163–216), remove all task logic:

Remove:
- `const isTaskRequest = !!request.params.task;` (line 173)
- `const taskSupport = tool.execution?.taskSupport;` (line 174)
- `const isTaskHandler = 'createTask' in (tool.handler as AnyToolHandler<StandardSchemaWithJSON>);` (line 175)
- The taskSupport validation block (lines 178–183)
- The `taskSupport === 'required'` guard (lines 186–191)
- The `taskSupport === 'optional'` automatic polling block (lines 194–196)
- The `if (isTaskRequest) { return result; }` block (lines 203–205)

The handler becomes just: validate input → execute → validate output → return.

Change the handler return type from `Promise<CallToolResult | CreateTaskResult>` to `Promise<CallToolResult>`.

- [ ] **Step 9: Remove `handleAutomaticTaskPolling()` method**

Delete the entire `handleAutomaticTaskPolling()` method (lines 310–339).

- [ ] **Step 10: Simplify `validateToolOutput()` and `executeToolHandler()` signatures**

In `validateToolOutput()` (line 268): Change parameter from `result: CallToolResult | CreateTaskResult` to `result: CallToolResult`. Remove the `if (!('content' in result))` guard (lines 274–276).

In `executeToolHandler()` (line 302): Change return type from `Promise<CallToolResult | CreateTaskResult>` to `Promise<CallToolResult>`.

- [ ] **Step 11: Remove `ToolExecution` from tool registration types**

In `mcp.ts`, find the `RegisteredTool` type and the `tool()` method overloads. Remove `execution?: ToolExecution` from any interfaces/types that carry it. If `ToolExecution` was the type for `execution`, note that `ToolExecutionSchema` is already deleted — the `execution` field on `ToolSchema` was removed in Task 2.

Also remove `taskSupport: 'forbidden'` default from any tool registration code (around line ~917 — search for it).

---

### Task 7: Clean up Client (`client.ts`)

**Files:**
- Modify: `packages/client/src/client/client.ts`

- [ ] **Step 1: Clean up imports**

Remove from type imports:
- `TaskManagerOptions` (line 32)

Remove from value imports:
- `assertClientRequestTaskCapability` (line 38)
- `assertToolsCallTaskCapability` (line 39)
- `CreateTaskResultSchema` (line 45)
- `extractTaskManagerOptions` (line 49)

Remove:
```typescript
import { ExperimentalClientTasks } from '../experimental/tasks/client.js';
```
(line 68)

- [ ] **Step 2: Remove `ClientTasksCapabilityWithRuntime` and simplify `ClientOptions`**

Remove the `ClientTasksCapabilityWithRuntime` type (line 148).

Simplify `ClientOptions.capabilities` — remove the `Omit<ClientCapabilities, 'tasks'>` and `tasks?` override (lines 154–156). Just use:
```typescript
capabilities?: ClientCapabilities;
```

- [ ] **Step 3: Remove task wiring from Client constructor**

- Remove `tasks: extractTaskManagerOptions(options?.capabilities?.tasks)` from super call (line 249) — just pass `...options`
- Remove the entire `if (options?.capabilities?.tasks)` block that strips runtime fields (lines 256–261)

- [ ] **Step 4: Remove task fields and experimental getter**

Remove:
- `private _cachedKnownTaskTools: Set<string> = new Set();` (line 233)
- `private _cachedRequiredTaskTools: Set<string> = new Set();` (line 234)
- `private _experimental?: { tasks: ExperimentalClientTasks };` (line 235)
- The `get experimental()` getter (lines 309–316)

- [ ] **Step 5: Remove task validation from `_wrapHandler()` for elicitation**

In `_wrapHandler()` for `elicitation/create` (around line ~339):

Remove the `if (params.task)` block (lines ~363–374) that validates `CreateTaskResult`. Keep only the non-task `ElicitResultSchema` validation path.

- [ ] **Step 6: Remove task validation from `_wrapHandler()` for sampling**

Find the `sampling/createMessage` section in `_wrapHandler()` (around line ~420). Remove the `if (params.task)` block (lines ~420–429).

- [ ] **Step 7: Remove task guard from `callTool()`**

In `callTool()` (line ~862), remove the task-required guard (lines ~863–869):
```typescript
if (this.isToolTaskRequired(params.name)) {
    throw new ProtocolError(...);
}
```

Also remove the task-related JSDoc comment about `client.experimental.tasks.callToolStream()` (line ~831).

- [ ] **Step 8: Remove task tool caching methods**

Remove:
- `isToolTask()` method (lines ~911–917)
- `isToolTaskRequired()` method (lines ~923–925)

In `cacheToolMetadata()` (lines ~931–952):
- Remove `this._cachedKnownTaskTools.clear();` and `this._cachedRequiredTaskTools.clear();`
- Remove the `taskSupport` caching block (lines ~943–950)

- [ ] **Step 9: Remove `assertTaskCapability()` and `assertTaskHandlerCapability()`**

Remove both methods (lines ~704–709).

---

### Task 8: Update barrel exports

**Files:**
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/exports/public/index.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `packages/client/src/index.ts`

- [ ] **Step 1: Clean up `packages/core/src/index.ts`**

Remove:
```typescript
export type { RequestTaskStore, TaskContext, TaskManagerOptions, TaskRequestOptions } from './shared/taskManager.js';
export { extractTaskManagerOptions, NullTaskManager, TaskManager } from './shared/taskManager.js';
```
(lines 9–10)

Remove:
```typescript
export * from './experimental/index.js';
```
(line 21)

- [ ] **Step 2: Clean up `packages/core/src/exports/public/index.ts`**

Remove the task manager types block (lines 54–55):
```typescript
// Task manager types (NOT TaskManager class itself — internal)
export type { RequestTaskStore, TaskContext, TaskManagerOptions, TaskRequestOptions } from '../../shared/taskManager.js';
```

Remove task response message types from the response message export block (lines 63–64):
```typescript
TaskCreatedMessage,
TaskStatusMessage
```

Remove the experimental task types and classes block (lines 121–138):
```typescript
// Experimental task types and classes
export { assertClientRequestTaskCapability, assertToolsCallTaskCapability } from '../../experimental/tasks/helpers.js';
export type { ... } from '../../experimental/tasks/interfaces.js';
export { isTerminal } from '../../experimental/tasks/interfaces.js';
export { InMemoryTaskMessageQueue, InMemoryTaskStore } from '../../experimental/tasks/stores/inMemory.js';
```

Remove `isTaskAugmentedRequestParams` from the guards export (line 117).

Remove `RELATED_TASK_META_KEY` from the constants export (line 95).

- [ ] **Step 3: Clean up `packages/server/src/index.ts`**

Remove the experimental exports block (lines 43–46):
```typescript
// experimental exports
export type { CreateTaskRequestHandler, TaskRequestHandler, ToolTaskHandler } from './experimental/tasks/interfaces.js';
export { ExperimentalMcpServerTasks } from './experimental/tasks/mcpServer.js';
export { ExperimentalServerTasks } from './experimental/tasks/server.js';
```

- [ ] **Step 4: Clean up `packages/client/src/index.ts`**

Remove the experimental exports block (lines 74–75):
```typescript
// experimental exports
export { ExperimentalClientTasks } from './experimental/tasks/client.js';
```

---

### Task 9: Clean up tests and examples

**Files:**
- Delete: `test/integration/test/experimental/tasks/` (entire directory)
- Delete: `test/integration/test/taskLifecycle.test.ts`
- Delete: `packages/core/test/experimental/` (entire directory)
- Delete: `test/helpers/src/helpers/tasks.ts`
- Delete: `examples/server/src/simpleTaskInteractive.ts`
- Delete: `examples/server/src/README-simpleTaskInteractive.md`
- Delete: `examples/client/src/simpleTaskInteractiveClient.ts`
- Modify: `test/helpers/src/index.ts`
- Modify: `packages/core/test/shared/protocol.test.ts`
- Modify: `examples/server/src/simpleStreamableHttp.ts`

- [ ] **Step 1: Delete task-specific test files**

```bash
rm -rf test/integration/test/experimental/tasks
rm test/integration/test/taskLifecycle.test.ts
rm -rf packages/core/test/experimental
```

- [ ] **Step 2: Delete task test helpers**

```bash
rm test/helpers/src/helpers/tasks.ts
```

Remove the re-export from `test/helpers/src/index.ts`:
```typescript
export * from './helpers/tasks.js';
```

- [ ] **Step 3: Delete task example files**

```bash
rm examples/server/src/simpleTaskInteractive.ts
rm examples/server/src/README-simpleTaskInteractive.md
rm examples/client/src/simpleTaskInteractiveClient.ts
```

- [ ] **Step 4: Remove task-related tests from `protocol.test.ts`**

In `packages/core/test/shared/protocol.test.ts`:

Remove all task-related imports (lines ~10–19):
- `TaskMessageQueue`, `TaskStore` from experimental interfaces
- `InMemoryTaskMessageQueue` from experimental stores
- `TaskManagerOptions`, `NullTaskManager`, `TaskManager` from taskManager

Remove `assertTaskCapability()` and `assertTaskHandlerCapability()` stubs from `TestProtocolImpl` (lines ~45–46).

Remove `taskOptions` parameter from `createTestProtocol()` (lines ~52–53).

Remove the `createMockTaskStore()` helper and all test blocks that use task functionality. Search for `describe` blocks containing "task" in their names and remove them entirely.

- [ ] **Step 5: Remove task configuration from `simpleStreamableHttp.ts` example**

In `examples/server/src/simpleStreamableHttp.ts`:

Remove imports of `InMemoryTaskMessageQueue`, `InMemoryTaskStore` (line 14).

Remove the task store creation (lines 25–26):
```typescript
const taskStore = new InMemoryTaskStore();
```

Remove the `tasks` field from server capabilities (lines 40–43):
```typescript
tasks: {
    ...
    taskStore,
    taskMessageQueue: new InMemoryTaskMessageQueue()
}
```

Remove the `registerToolTask` call and its entire implementation (lines ~442–483).

---

### Task 10: Delete changesets and update documentation

**Files:**
- Delete: `.changeset/extract-task-manager.md`
- Delete: `.changeset/fix-failed-task-result-retrieval.md`
- Delete: `.changeset/fix-task-session-isolation.md`
- Modify: `docs/migration.md`
- Modify: `docs/migration-SKILL.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Delete task-related changesets**

```bash
rm .changeset/extract-task-manager.md
rm .changeset/fix-failed-task-result-retrieval.md
rm .changeset/fix-task-session-isolation.md
```

- [ ] **Step 2: Remove task references from `docs/migration.md`**

Remove:
- The `` `CreateTaskResult` `` mention in the return type description (line ~488)
- The `extra.taskStore` → `ctx.task?.store` migration rows (lines ~594–596)
- The task code examples (lines ~603–625)
- The `task?` mention in context field descriptions (line ~624)
- The entire "Experimental: TaskCreationParams.ttl no longer accepts null" section (lines ~856–895)

- [ ] **Step 3: Remove task references from `docs/migration-SKILL.md`**

Remove:
- The `extra.taskStore`/`extra.taskId`/`extra.taskRequestedTtl` migration rows (lines ~423–425)
- The entire section "12. Experimental: TaskCreationParams.ttl no longer accepts null" (lines ~476–493)

- [ ] **Step 4: Remove task references from `CLAUDE.md`**

Remove:
- The `task?` field from `BaseContext` description
- The `task?` field from `ServerContext` description
- References to `TaskManager` and experimental tasks
- The `- **Tasks**: Long-running task support with polling/resumption` line under Experimental Features

---

### Task 11: Build and test

**Files:** None (verification only)

- [ ] **Step 1: Build all packages**

```bash
pnpm build:all
```

Expected: Clean build with no errors.

- [ ] **Step 2: Type-check all packages**

```bash
pnpm typecheck:all
```

Expected: No type errors.

- [ ] **Step 3: Run lint**

```bash
pnpm lint:all
```

Expected: Clean or only pre-existing warnings. Fix any new lint errors introduced by the removal.

- [ ] **Step 4: Run all tests**

```bash
pnpm test:all
```

Expected: All tests pass. Any remaining test failures indicate missed task references.

- [ ] **Step 5: Fix any remaining issues**

If any step above fails, grep the codebase for remaining references:
```bash
grep -rn "task\|Task" packages/ --include='*.ts' | grep -v node_modules | grep -v '.d.ts' | grep -v 'test/' | grep -iv 'import.*taskCreate\|TaskCreate\|TaskUpdate\|TaskGet'
```

Fix any remaining references found.

- [ ] **Step 6: Suggest commit**

Suggest a commit with message:
```
feat!: remove Tasks feature entirely

Remove all experimental task-augmented execution support: TaskManager,
TaskStore, task schemas, task capability negotiation, and experimental
client/server task APIs.

BREAKING CHANGE: Tasks feature removed. All task-related types, schemas,
and APIs are no longer available.
```
