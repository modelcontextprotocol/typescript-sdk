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
    StandardSchemaWithJSON,
    TaskServerContext
} from '@modelcontextprotocol/core';

import type { AnyToolHandler, BaseToolCallback } from '../../server/mcp.js';

// ============================================================================
// Task Handler Types (for registerToolTask)
// ============================================================================

/**
 * Handler for creating a task.
 * @experimental
 */
export type CreateTaskRequestHandler<
    SendResultT extends Result,
    Args extends StandardSchemaWithJSON | undefined = undefined
> = BaseToolCallback<SendResultT, CreateTaskServerContext, Args>;

/**
 * Handler for task operations (`get`, `getResult`).
 *
 * Receives only the context (no tool arguments — they are not available at
 * `tasks/get` or `tasks/result` time). Access the task ID via `ctx.task.id`.
 *
 * @experimental
 */
export type TaskRequestHandler<SendResultT extends Result> = (ctx: TaskServerContext) => SendResultT | Promise<SendResultT>;

/**
 * Interface for task-based tool handlers.
 *
 * Task-based tools create a task on `tools/call` and by default let the SDK's
 * `TaskStore` handle subsequent `tasks/get` and `tasks/result` requests.
 *
 * Provide `getTask` and `getTaskResult` to override the default lookups — useful
 * when proxying an external job system (e.g., AWS Step Functions, CI/CD pipelines)
 * where the external system is the source of truth for task state.
 *
 * **Note:** the taskId → tool mapping used to dispatch `getTask`/`getTaskResult`
 * is held in-memory and does not survive server restarts or span multiple
 * instances. In those scenarios, requests fall through to the `TaskStore`.
 *
 * @see {@linkcode @modelcontextprotocol/server!experimental/tasks/mcpServer.ExperimentalMcpServerTasks#registerToolTask | registerToolTask} for registration.
 * @experimental
 */
export interface ToolTaskHandler<Args extends StandardSchemaWithJSON | undefined = undefined> {
    /**
     * Called on the initial `tools/call` request.
     *
     * Creates a task via `ctx.task.store.createTask(...)`, starts any
     * background work, and returns the task object.
     */
    createTask: CreateTaskRequestHandler<CreateTaskResult, Args>;
    /**
     * Optional handler for `tasks/get` requests. When omitted, the configured
     * `TaskStore` is consulted directly.
     */
    getTask?: TaskRequestHandler<GetTaskResult>;
    /**
     * Optional handler for `tasks/result` requests. When omitted, the configured
     * `TaskStore` is consulted directly.
     */
    getTaskResult?: TaskRequestHandler<CallToolResult>;
}

/**
 * Type guard for {@linkcode ToolTaskHandler}.
 * @experimental
 */
export function isToolTaskHandler(
    handler: AnyToolHandler<StandardSchemaWithJSON | undefined>
): handler is ToolTaskHandler<StandardSchemaWithJSON | undefined> {
    return 'createTask' in handler;
}
