/**
 * `@modelcontextprotocol/client/ext/tasks` — the client side of the MCP
 * Tasks extension (`io.modelcontextprotocol/tasks`).
 *
 * `TasksClientExtension` advertises the capability, accepts task handles on
 * `tools/call`, and wraps `tasks/get`, `tasks/update` and `tasks/cancel`,
 * plus `waitFor` to poll a task to a terminal status.
 */

export type { CallToolOutcome, TerminalTask, WaitForOptions } from './tasksClientExtension';
export { TasksClientExtension } from './tasksClientExtension';
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
    InputRequiredTask,
    Task,
    TaskInputRequest,
    TaskInputRequests,
    TaskInputResponse,
    TaskInputResponses,
    TasksExtensionCapability,
    TaskStatus,
    UpdateTaskParams,
    UpdateTaskRequest,
    UpdateTaskResult,
    WorkingTask
} from '@modelcontextprotocol/core/ext/tasks';
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
} from '@modelcontextprotocol/core/ext/tasks';
export { TASK_STATUSES, TASKS_EXTENSION_ID } from '@modelcontextprotocol/core/ext/tasks';
// The SDK's precise input request and response types, which requireInput and update take.
export type { InputRequest, InputRequests, InputResponse, InputResponses } from '@modelcontextprotocol/core-internal';
