/*
 * Zod schemas for the MCP Tasks extension wire types, written against
 * modelcontextprotocol/ext-tasks at dcc8d2b (SEP-2663 Final). Objects are loose
 * and `resultType` literals are required on results.
 * https://github.com/modelcontextprotocol/ext-tasks
 *
 * Copyright (c) Model Context Protocol contributors
 */

import * as z from 'zod/v4';

import { TASK_STATUSES } from './constants';

/**
 * `TaskStatus`
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export const taskStatusSchema = z.enum(TASK_STATUSES);

const metaSchema = z.record(z.string(), z.unknown());

/**
 * An embedded (de-JSON-RPC'd) input request: an elicitation, sampling, or
 * roots request object (`{method, params}`), validated structurally.
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export const inputRequestSchema = z.looseObject({
    method: z.string(),
    params: z.record(z.string(), z.unknown()).optional()
});

/**
 * An embedded input response: the bare result object for its request.
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export const inputResponseSchema = z.record(z.string(), z.unknown());

/**
 * `InputRequests` — keyed by identifiers unique over the task's lifetime.
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export const inputRequestsSchema = z.record(z.string(), inputRequestSchema);

/**
 * `InputResponses` — keys correspond to outstanding inputRequest keys.
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export const inputResponsesSchema = z.record(z.string(), inputResponseSchema);

const taskShape = {
    taskId: z.string(),
    status: taskStatusSchema,
    statusMessage: z.string().optional(),
    createdAt: z.string(),
    lastUpdatedAt: z.string(),
    ttlMs: z.int().nullable(),
    pollIntervalMs: z.int().optional()
};

/**
 * `Task`
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export const taskSchema = z.looseObject(taskShape);

/**
 * `WorkingTask`
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export const workingTaskSchema = z.looseObject({
    ...taskShape,
    status: z.literal('working')
});

/**
 * `InputRequiredTask`
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export const inputRequiredTaskSchema = z.looseObject({
    ...taskShape,
    status: z.literal('input_required'),
    inputRequests: inputRequestsSchema
});

/**
 * `CompletedTask` — the original request's result structure inlined.
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export const completedTaskSchema = z.looseObject({
    ...taskShape,
    status: z.literal('completed'),
    result: z.record(z.string(), z.unknown())
});

/**
 * `FailedTask` — the JSON-RPC error object inlined.
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export const failedTaskSchema = z.looseObject({
    ...taskShape,
    status: z.literal('failed'),
    error: z.record(z.string(), z.unknown())
});

/**
 * `CancelledTask`
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export const cancelledTaskSchema = z.looseObject({
    ...taskShape,
    status: z.literal('cancelled')
});

/**
 * `DetailedTask` — discriminated on `status`.
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export const detailedTaskSchema = z.discriminatedUnion('status', [
    workingTaskSchema,
    inputRequiredTaskSchema,
    completedTaskSchema,
    failedTaskSchema,
    cancelledTaskSchema
]);

/**
 * `CreateTaskResult` — flat `Result & Task` with `resultType: "task"` (MUST).
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export const createTaskResultSchema = z.looseObject({
    ...taskShape,
    resultType: z.literal('task'),
    _meta: metaSchema.optional()
});

const completeResultShape = {
    resultType: z.literal('complete'),
    _meta: metaSchema.optional()
};

/**
 * `GetTaskResult` — a `DetailedTask` variant with `resultType: "complete"` (MUST).
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export const getTaskResultSchema = z.discriminatedUnion('status', [
    workingTaskSchema.extend(completeResultShape),
    inputRequiredTaskSchema.extend(completeResultShape),
    completedTaskSchema.extend(completeResultShape),
    failedTaskSchema.extend(completeResultShape),
    cancelledTaskSchema.extend(completeResultShape)
]);

/**
 * `UpdateTaskResult` — empty ack with `resultType: "complete"` (MUST).
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export const updateTaskResultSchema = z.looseObject(completeResultShape);

/**
 * `CancelTaskResult` — empty ack with `resultType: "complete"` (MUST).
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export const cancelTaskResultSchema = z.looseObject(completeResultShape);

const requestIdSchema = z.union([z.string(), z.int()]);

/**
 * `tasks/get` params (`_meta` carries the modern per-request envelope).
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export const getTaskParamsSchema = z.looseObject({
    taskId: z.string(),
    _meta: metaSchema.optional()
});

/**
 * `GetTaskRequest`
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export const getTaskRequestSchema = z.looseObject({
    jsonrpc: z.literal('2.0'),
    id: requestIdSchema,
    method: z.literal('tasks/get'),
    params: getTaskParamsSchema
});

/**
 * `tasks/update` params (`_meta` carries the modern per-request envelope).
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export const updateTaskParamsSchema = z.looseObject({
    taskId: z.string(),
    inputResponses: inputResponsesSchema,
    _meta: metaSchema.optional()
});

/**
 * `UpdateTaskRequest`
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export const updateTaskRequestSchema = z.looseObject({
    jsonrpc: z.literal('2.0'),
    id: requestIdSchema,
    method: z.literal('tasks/update'),
    params: updateTaskParamsSchema
});

/**
 * `tasks/cancel` params (`_meta` carries the modern per-request envelope).
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export const cancelTaskParamsSchema = z.looseObject({
    taskId: z.string(),
    _meta: metaSchema.optional()
});

/**
 * `CancelTaskRequest`
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export const cancelTaskRequestSchema = z.looseObject({
    jsonrpc: z.literal('2.0'),
    id: requestIdSchema,
    method: z.literal('tasks/cancel'),
    params: cancelTaskParamsSchema
});

/**
 * `TasksExtensionCapability` — an empty object declares support.
 *
 * Experimental: may change in a minor release while the extensions SEPs settle.
 *
 * @experimental
 */
export const tasksExtensionCapabilitySchema = z.strictObject({});
