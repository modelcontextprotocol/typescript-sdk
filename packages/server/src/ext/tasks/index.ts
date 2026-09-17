/**
 * `@modelcontextprotocol/server/ext/tasks` — the server side of the MCP
 * Tasks extension (`io.modelcontextprotocol/tasks`).
 *
 * `TasksExtension` owns the wire: capability, `tasks/get` / `tasks/update` /
 * `tasks/cancel`, the client-capability check, and the `tools/call` task
 * handle. A `TaskStore` owns the task: `InMemoryTaskStore` is the
 * in-process reference; durable stores implement the same four methods and
 * live outside the SDK. How the work behind a task runs is the server's
 * own.
 */

export type { InMemoryTaskStoreOptions, TaskHandle } from './inMemoryStore';
export { InMemoryTaskStore } from './inMemoryStore';
export type { CreateTaskParams, TaskAccess, TaskStore } from './store';
export type { CreateTaskOptions, TasksExtensionOptions, TaskToolResult } from './tasksExtension';
export { declaresTasksExtension, TasksExtension } from './tasksExtension';
export {
    cancelledTaskSchema,
    cancelTaskParamsSchema,
    cancelTaskRequestSchema,
    cancelTaskResultSchema,
    completedTaskSchema,
    createTaskResultSchema,
    detailedTaskSchema,
    failedTaskSchema,
    getTaskParamsSchema,
    getTaskRequestSchema,
    getTaskResultSchema,
    inputRequestSchema,
    inputRequestsSchema,
    inputRequiredTaskSchema,
    inputResponseSchema,
    inputResponsesSchema,
    taskSchema,
    tasksExtensionCapabilitySchema,
    taskStatusSchema,
    updateTaskParamsSchema,
    updateTaskRequestSchema,
    updateTaskResultSchema,
    workingTaskSchema
} from './wire/schemas';
export type {
    CancelledTask,
    CancelTaskParams,
    CancelTaskRequest,
    CancelTaskResult,
    CompletedTask,
    CreateTaskResult,
    DetailedTask,
    FailedTask,
    GetTaskParams,
    GetTaskRequest,
    GetTaskResult,
    InputRequest,
    InputRequests,
    InputRequiredTask,
    InputResponse,
    InputResponses,
    Task,
    TasksExtensionCapability,
    TaskStatus,
    UpdateTaskParams,
    UpdateTaskRequest,
    UpdateTaskResult,
    WorkingTask
} from './wire/types';
export { TASK_STATUSES, TASKS_EXTENSION_ID } from './wire/types';
