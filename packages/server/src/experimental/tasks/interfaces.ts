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

import type { BaseToolCallback } from '../../server/mcp.js';

// ============================================================================
// Task Handler Types (for registerToolTask)
// ============================================================================

type TaskCallbackWithoutArgs<SendResultT extends Result, Ctx extends TaskServerContext | CreateTaskServerContext> =
    | ((ctx: Ctx) => SendResultT | Promise<SendResultT>)
    | ((_args: undefined, ctx: Ctx) => SendResultT | Promise<SendResultT>);

/**
 * Handler for creating a task.
 * @experimental
 */
export type CreateTaskRequestHandler<
    SendResultT extends Result,
    Args extends StandardSchemaWithJSON | undefined = undefined
> = Args extends StandardSchemaWithJSON
    ? BaseToolCallback<SendResultT, CreateTaskServerContext, Args>
    : TaskCallbackWithoutArgs<SendResultT, CreateTaskServerContext>;

/**
 * Handler for task operations (`get`, `getResult`).
 * @experimental
 */
export type TaskRequestHandler<
    SendResultT extends Result,
    Args extends StandardSchemaWithJSON | undefined = undefined
> = Args extends StandardSchemaWithJSON
    ? BaseToolCallback<SendResultT, TaskServerContext, Args>
    : TaskCallbackWithoutArgs<SendResultT, TaskServerContext>;

/**
 * Interface for task-based tool handlers.
 *
 * Task-based tools split a long-running operation into three phases:
 * `createTask`, `getTask`, and `getTaskResult`.
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
     * Handler for `tasks/get` requests.
     */
    getTask: TaskRequestHandler<GetTaskResult, Args>;
    /**
     * Handler for `tasks/result` requests.
     */
    getTaskResult: TaskRequestHandler<CallToolResult, Args>;
}
