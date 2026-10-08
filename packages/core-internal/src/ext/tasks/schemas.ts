/*
 * Hand-written zod v4 schemas for the MCP Tasks extension wire types
 * (./types). Upstream commits only generated JSON Schema
 * (`schema/draft/schema.json`, vendored at `test/fixtures/ext-tasks.schema.json`
 * as the conformance fixture); these runtime schemas are authored against
 * modelcontextprotocol/ext-tasks pinned at commit dcc8d2b (SEP-2663 Final).
 * https://github.com/modelcontextprotocol/ext-tasks
 *
 * Deliberate deviations from the generated fixture, which reflects the
 * pre-envelope TS source rather than the wire:
 * - Objects are loose (unknown keys pass through) where the fixture says
 *   `additionalProperties: false`: modern responses carry `resultType` and
 *   `_meta`, and modern request params carry the `_meta` envelope.
 * - `resultType` literals are REQUIRED on result schemas (spec MUST; the
 *   fixture omits the field entirely).
 * - `InputRequest`/`InputResponse` get minimal structural checks (the fixture
 *   degenerates them to `anyOf [{}, {}, {}]`).
 *
 * Copyright (c) Model Context Protocol contributors
 */

import * as z from 'zod/v4';

import { TASK_STATUSES } from './types';

/** `TaskStatus` */
export const taskStatusSchema = z.enum(TASK_STATUSES);

const metaSchema = z.record(z.string(), z.unknown());

/**
 * An embedded (de-JSON-RPC'd) input request: an elicitation, sampling, or
 * roots request object (`{method, params}`), validated structurally.
 */
export const inputRequestSchema = z.looseObject({
    method: z.string(),
    params: z.record(z.string(), z.unknown()).optional()
});

/** An embedded input response: the bare result object for its request. */
export const inputResponseSchema = z.record(z.string(), z.unknown());

/** `InputRequests` — keyed by identifiers unique over the task's lifetime. */
export const inputRequestsSchema = z.record(z.string(), inputRequestSchema);

/** `InputResponses` — keys correspond to outstanding inputRequest keys. */
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

/** `Task` */
export const taskSchema = z.looseObject(taskShape);

/** `WorkingTask` */
export const workingTaskSchema = z.looseObject({
    ...taskShape,
    status: z.literal('working')
});

/** `InputRequiredTask` */
export const inputRequiredTaskSchema = z.looseObject({
    ...taskShape,
    status: z.literal('input_required'),
    inputRequests: inputRequestsSchema
});

/** `CompletedTask` — the original request's result structure inlined. */
export const completedTaskSchema = z.looseObject({
    ...taskShape,
    status: z.literal('completed'),
    result: z.record(z.string(), z.unknown())
});

/** `FailedTask` — the JSON-RPC error object inlined. */
export const failedTaskSchema = z.looseObject({
    ...taskShape,
    status: z.literal('failed'),
    error: z.record(z.string(), z.unknown())
});

/** `CancelledTask` */
export const cancelledTaskSchema = z.looseObject({
    ...taskShape,
    status: z.literal('cancelled')
});

/** `DetailedTask` — discriminated on `status`. */
export const detailedTaskSchema = z.discriminatedUnion('status', [
    workingTaskSchema,
    inputRequiredTaskSchema,
    completedTaskSchema,
    failedTaskSchema,
    cancelledTaskSchema
]);

/** `CreateTaskResult` — flat `Result & Task` with `resultType: "task"` (MUST). */
export const createTaskResultSchema = z.looseObject({
    ...taskShape,
    resultType: z.literal('task'),
    _meta: metaSchema.optional()
});

const completeResultShape = {
    resultType: z.literal('complete'),
    _meta: metaSchema.optional()
};

/** `GetTaskResult` — a `DetailedTask` variant with `resultType: "complete"` (MUST). */
export const getTaskResultSchema = z.discriminatedUnion('status', [
    workingTaskSchema.extend(completeResultShape),
    inputRequiredTaskSchema.extend(completeResultShape),
    completedTaskSchema.extend(completeResultShape),
    failedTaskSchema.extend(completeResultShape),
    cancelledTaskSchema.extend(completeResultShape)
]);

/** `UpdateTaskResult` — empty ack with `resultType: "complete"` (MUST). */
export const updateTaskResultSchema = z.looseObject(completeResultShape);

/** `CancelTaskResult` — empty ack with `resultType: "complete"` (MUST). */
export const cancelTaskResultSchema = z.looseObject(completeResultShape);

const requestIdSchema = z.union([z.string(), z.int()]);

/** `tasks/get` params (`_meta` carries the modern per-request envelope). */
export const getTaskParamsSchema = z.looseObject({
    taskId: z.string(),
    _meta: metaSchema.optional()
});

/** `GetTaskRequest` */
export const getTaskRequestSchema = z.looseObject({
    jsonrpc: z.literal('2.0'),
    id: requestIdSchema,
    method: z.literal('tasks/get'),
    params: getTaskParamsSchema
});

/** `tasks/update` params (`_meta` carries the modern per-request envelope). */
export const updateTaskParamsSchema = z.looseObject({
    taskId: z.string(),
    inputResponses: inputResponsesSchema,
    _meta: metaSchema.optional()
});

/** `UpdateTaskRequest` */
export const updateTaskRequestSchema = z.looseObject({
    jsonrpc: z.literal('2.0'),
    id: requestIdSchema,
    method: z.literal('tasks/update'),
    params: updateTaskParamsSchema
});

/** `tasks/cancel` params (`_meta` carries the modern per-request envelope). */
export const cancelTaskParamsSchema = z.looseObject({
    taskId: z.string(),
    _meta: metaSchema.optional()
});

/** `CancelTaskRequest` */
export const cancelTaskRequestSchema = z.looseObject({
    jsonrpc: z.literal('2.0'),
    id: requestIdSchema,
    method: z.literal('tasks/cancel'),
    params: cancelTaskParamsSchema
});

/** `TasksExtensionCapability` — an empty object declares support. */
export const tasksExtensionCapabilitySchema = z.strictObject({});
