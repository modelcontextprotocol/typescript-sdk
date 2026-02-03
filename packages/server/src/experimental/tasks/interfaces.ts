/**
 * Experimental task interfaces for MCP SDK.
 * WARNING: These APIs are experimental and may change without notice.
 */

import type {
    AnySchema,
    CallToolResult,
    CreateTaskResult,
    CreateTaskServerContext,
    GetTaskResult,
    Result,
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
export type CreateTaskRequestHandler<ResultT extends Result, Args extends AnySchema | undefined = undefined> = BaseToolCallback<
    ResultT,
    CreateTaskServerContext,
    Args
>;

/**
 * Handler for task operations (get, getResult).
 * @experimental
 */
export type TaskRequestHandler<ResultT extends Result, Args extends AnySchema | undefined = undefined> = BaseToolCallback<
    ResultT,
    TaskServerContext,
    Args
>;

/**
 * Interface for task-based tool handlers.
 * @experimental
 */
export interface ToolTaskHandler<Args extends AnySchema | undefined = undefined> {
    createTask: CreateTaskRequestHandler<CreateTaskResult, Args>;
    getTask: TaskRequestHandler<GetTaskResult, Args>;
    getTaskResult: TaskRequestHandler<CallToolResult, Args>;
}
