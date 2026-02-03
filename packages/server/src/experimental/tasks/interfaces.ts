/**
 * Experimental task interfaces for MCP SDK.
 * WARNING: These APIs are experimental and may change without notice.
 */

import type {
    CallToolResult,
    CreateTaskResult,
    CreateTaskServerContext,
    GetTaskResult,
    Result,
    StandardJSONSchemaV1,
    TaskServerContext
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
    Args extends StandardJSONSchemaV1 | undefined = undefined
> = BaseToolCallback<SendResultT, CreateTaskServerContext, Args>;

/**
 * Handler for task operations (get, getResult).
 * @experimental
 */
export type TaskRequestHandler<
    SendResultT extends Result,
    Args extends StandardJSONSchemaV1 | undefined = undefined
> = BaseToolCallback<SendResultT, TaskServerContext, Args>;

/**
 * Interface for task-based tool handlers.
 * @experimental
 */
export interface ToolTaskHandler<Args extends StandardJSONSchemaV1 | undefined = undefined> {
    createTask: CreateTaskRequestHandler<CreateTaskResult, Args>;
    getTask: TaskRequestHandler<GetTaskResult, Args>;
    getTaskResult: TaskRequestHandler<CallToolResult, Args>;
}
