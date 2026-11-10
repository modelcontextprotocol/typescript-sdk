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

/**
 * The status of a task.
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/**
 * A request embedded in a task for the client to fulfil: an elicitation,
 * sampling, or roots request (`{ method, params }`).
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export type TaskInputRequest = z.infer<typeof inputRequestSchema>;
/**
 * Input requests keyed by identifiers unique over the task's lifetime.
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export type TaskInputRequests = z.infer<typeof inputRequestsSchema>;
/**
 * The bare result object answering one input request.
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export type TaskInputResponse = z.infer<typeof inputResponseSchema>;
/**
 * Input responses keyed like the input requests they answer.
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export type TaskInputResponses = z.infer<typeof inputResponsesSchema>;

/**
 * Data associated with a task.
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export type Task = z.infer<typeof taskSchema>;
/**
 * A task that is running.
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export type WorkingTask = z.infer<typeof workingTaskSchema>;
/**
 * A task waiting for the client to answer `inputRequests` through `tasks/update`.
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export type InputRequiredTask = z.infer<typeof inputRequiredTaskSchema>;
/**
 * A finished task, with the original request's result inlined (`isError` tool results included).
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export type CompletedTask = z.infer<typeof completedTaskSchema>;
/**
 * A task that ended in a JSON-RPC error, inlined as `error`.
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export type FailedTask = z.infer<typeof failedTaskSchema>;
/**
 * A cancelled task.
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export type CancelledTask = z.infer<typeof cancelledTaskSchema>;
/**
 * A task snapshot, discriminated on `status`.
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export type DetailedTask = z.infer<typeof detailedTaskSchema>;

/**
 * The task handle a request answers with: flat `Result & Task`, `resultType: "task"`.
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export type CreateTaskResult = z.infer<typeof createTaskResultSchema>;

/**
 * `tasks/get` params.
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export type GetTaskParams = z.infer<typeof getTaskParamsSchema>;
/**
 * `tasks/get` request.
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export type GetTaskRequest = z.infer<typeof getTaskRequestSchema>;
/**
 * `tasks/get` result: a `DetailedTask` with `resultType: "complete"`.
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export type GetTaskResult = z.infer<typeof getTaskResultSchema>;
/**
 * `tasks/update` params.
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export type UpdateTaskParams = z.infer<typeof updateTaskParamsSchema>;
/**
 * `tasks/update` request.
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export type UpdateTaskRequest = z.infer<typeof updateTaskRequestSchema>;
/**
 * `tasks/update` result: an empty ack.
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export type UpdateTaskResult = z.infer<typeof updateTaskResultSchema>;
/**
 * `tasks/cancel` params.
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export type CancelTaskParams = z.infer<typeof cancelTaskParamsSchema>;
/**
 * `tasks/cancel` request.
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export type CancelTaskRequest = z.infer<typeof cancelTaskRequestSchema>;
/**
 * `tasks/cancel` result: an empty ack.
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export type CancelTaskResult = z.infer<typeof cancelTaskResultSchema>;

/**
 * The capability a peer declares under `capabilities.extensions["io.modelcontextprotocol/tasks"]`.
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export type TasksExtensionCapability = z.infer<typeof tasksExtensionCapabilitySchema>;
