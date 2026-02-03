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
    TaskRequestHandlerExtra
} from '@modelcontextprotocol/core';

import type { BaseToolCallback } from '../../server/mcp.js';

// ============================================================================
// Task Handler Types (for registerToolTask)
// ============================================================================

/**
 * Handler for creating a task.
 * @experimental
 */
export type CreateTaskRequestHandler<SendResultT extends Result, Args extends AnySchema | undefined = undefined> = BaseToolCallback<
    SendResultT,
    CreateTaskRequestHandlerExtra,
    Args
>;

/**
 * Handler for task operations (get, getResult).
 * @experimental
 */
export type TaskRequestHandler<SendResultT extends Result, Args extends AnySchema | undefined = undefined> = BaseToolCallback<
    SendResultT,
    TaskRequestHandlerExtra,
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
