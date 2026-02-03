/**
 * Experimental task interfaces for MCP SDK.
 * WARNING: These APIs are experimental and may change without notice.
 */

import type {
    AnySchema,
    CallToolResult,
    CreateTaskResult,
    GetTaskResult,
    Result,
    ServerNotification,
    ServerRequest,
    ZodRawShapeCompat
} from '@modelcontextprotocol/core';

import type { ServerContext } from '../../server/context.js';
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
> = BaseToolCallback<SendResultT, ServerContext<ServerRequest, ServerNotification, Result>, Args>;

/**
 * Handler for task operations (get, getResult).
 * @experimental
 */
export type TaskRequestHandler<
    SendResultT extends Result,
    Args extends undefined | ZodRawShapeCompat | AnySchema = undefined
> = BaseToolCallback<SendResultT, ServerContext<ServerRequest, ServerNotification, Result>, Args>;

/**
 * Interface for task-based tool handlers.
 * @experimental
 */
export interface ToolTaskHandler<Args extends undefined | ZodRawShapeCompat | AnySchema = undefined> {
    createTask: CreateTaskRequestHandler<CreateTaskResult, Args>;
    getTask: TaskRequestHandler<GetTaskResult, Args>;
    getTaskResult: TaskRequestHandler<CallToolResult, Args>;
}
