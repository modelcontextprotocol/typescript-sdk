import type * as z from 'zod/v4';

import type {
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
} from './schemas';

/** The status of a task. */
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/**
 * A request embedded in a task for the client to fulfil: an elicitation,
 * sampling, or roots request (`{ method, params }`).
 */
export type TaskInputRequest = z.infer<typeof inputRequestSchema>;
/** Input requests keyed by identifiers unique over the task's lifetime. */
export type TaskInputRequests = z.infer<typeof inputRequestsSchema>;
/** The bare result object answering one input request. */
export type TaskInputResponse = z.infer<typeof inputResponseSchema>;
/** Input responses keyed like the input requests they answer. */
export type TaskInputResponses = z.infer<typeof inputResponsesSchema>;

/** Data associated with a task. */
export type Task = z.infer<typeof taskSchema>;
/** A task that is running. */
export type WorkingTask = z.infer<typeof workingTaskSchema>;
/** A task waiting for the client to answer `inputRequests` through `tasks/update`. */
export type InputRequiredTask = z.infer<typeof inputRequiredTaskSchema>;
/** A finished task, with the original request's result inlined (`isError` tool results included). */
export type CompletedTask = z.infer<typeof completedTaskSchema>;
/** A task that ended in a JSON-RPC error, inlined as `error`. */
export type FailedTask = z.infer<typeof failedTaskSchema>;
/** A cancelled task. */
export type CancelledTask = z.infer<typeof cancelledTaskSchema>;
/** A task snapshot, discriminated on `status`. */
export type DetailedTask = z.infer<typeof detailedTaskSchema>;

/** The task handle a request answers with: flat `Result & Task`, `resultType: "task"`. */
export type CreateTaskResult = z.infer<typeof createTaskResultSchema>;

/** `tasks/get` params. */
export type GetTaskParams = z.infer<typeof getTaskParamsSchema>;
/** `tasks/get` request. */
export type GetTaskRequest = z.infer<typeof getTaskRequestSchema>;
/** `tasks/get` result: a `DetailedTask` with `resultType: "complete"`. */
export type GetTaskResult = z.infer<typeof getTaskResultSchema>;
/** `tasks/update` params. */
export type UpdateTaskParams = z.infer<typeof updateTaskParamsSchema>;
/** `tasks/update` request. */
export type UpdateTaskRequest = z.infer<typeof updateTaskRequestSchema>;
/** `tasks/update` result: an empty ack. */
export type UpdateTaskResult = z.infer<typeof updateTaskResultSchema>;
/** `tasks/cancel` params. */
export type CancelTaskParams = z.infer<typeof cancelTaskParamsSchema>;
/** `tasks/cancel` request. */
export type CancelTaskRequest = z.infer<typeof cancelTaskRequestSchema>;
/** `tasks/cancel` result: an empty ack. */
export type CancelTaskResult = z.infer<typeof cancelTaskResultSchema>;

/** The capability a peer declares under `capabilities.extensions["io.modelcontextprotocol/tasks"]`. */
export type TasksExtensionCapability = z.infer<typeof tasksExtensionCapabilitySchema>;
