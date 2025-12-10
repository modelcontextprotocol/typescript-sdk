/**
 * Experimental task interfaces for MCP SDK.
 * WARNING: These APIs are experimental and may change without notice.
 */

import {
    Result,
    CallToolResult,
    GetTaskResult} from '@modelcontextprotocol/shared';
import { CreateTaskResult } from '@modelcontextprotocol/shared';
import type { CreateTaskRequestHandlerExtra, TaskRequestHandlerExtra } from '@modelcontextprotocol/shared';
import type { ZodRawShapeCompat, AnySchema } from '@modelcontextprotocol/shared';
import { BaseToolCallback } from 'src/server/mcp.js';

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
 * @experimental
 */
export type TaskRequestHandler<
    SendResultT extends Result,
    Args extends undefined | ZodRawShapeCompat | AnySchema = undefined
> = BaseToolCallback<SendResultT, TaskRequestHandlerExtra, Args>;

/**
 * Interface for task-based tool handlers.
 * @experimental
 */
export interface ToolTaskHandler<Args extends undefined | ZodRawShapeCompat | AnySchema = undefined> {
    createTask: CreateTaskRequestHandler<CreateTaskResult, Args>;
    getTask: TaskRequestHandler<GetTaskResult, Args>;
    getTaskResult: TaskRequestHandler<CallToolResult, Args>;
}
