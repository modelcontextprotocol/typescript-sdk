/**
 * Experimental task interfaces for MCP SDK.
 * WARNING: These APIs are experimental and may change without notice.
 */

import type {
    AnySchema,
    CallToolResult,
    CreateTaskRequestHandlerExtra,
    CreateTaskResult,
    GetTaskResult,
    Result,
    TaskRequestHandlerExtra,
    ZodRawShapeCompat
} from '@modelcontextprotocol/core';

import type { BaseToolCallback } from '../../server/mcp.js';

// ============================================================================
// Task Handler Types (for registerToolTask)
// ============================================================================

/**
 * Handler for creating a task.
 * @experimental
 */
export type CreateTaskRequestHandler<
    SendResultT extends Result,
    Args extends undefined | ZodRawShapeCompat | AnySchema = undefined
> = BaseToolCallback<SendResultT, CreateTaskRequestHandlerExtra, Args>;

/**
 * Handler for task operations (get, getResult).
 * These handlers do not receive the original args - only the extra context with taskId and taskStore.
 * This design supports horizontal scaling where the server handling getTask/getTaskResult
 * may be different from the one that handled createTask.
 * @experimental
 */
export type TaskRequestHandler<SendResultT extends Result> = (
    extra: TaskRequestHandlerExtra
) => SendResultT | Promise<SendResultT>;

/**
 * Interface for task-based tool handlers.
 * @experimental
 */
export interface ToolTaskHandler<Args extends undefined | ZodRawShapeCompat | AnySchema = undefined> {
    createTask: CreateTaskRequestHandler<CreateTaskResult, Args>;
    getTask: TaskRequestHandler<GetTaskResult>;
    getTaskResult: TaskRequestHandler<CallToolResult>;
}
