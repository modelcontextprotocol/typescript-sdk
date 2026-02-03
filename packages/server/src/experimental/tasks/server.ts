/**
 * Experimental server task features for MCP SDK.
 * WARNING: These APIs are experimental and may change without notice.
 *
 * @experimental
 */

import type {
    AnyObjectSchema,
    AnySchema,
    CancelTaskResult,
    GetTaskResult,
    ListTasksResult,
    Request,
    RequestOptions,
    ResponseMessage,
    Result,
    SchemaOutput
} from '@modelcontextprotocol/core';

import type { Server } from '../../server/server.js';

/**
 * Experimental task features for low-level MCP servers.
 *
 * Access via `server.experimental.tasks`:
 * ```typescript
 * const stream = server.experimental.tasks.requestStream(request, schema, options);
 * ```
 *
 * For high-level server usage with task-based tools, use `McpServer.experimental.tasks` instead.
 *
 * @experimental
 */
export class ExperimentalServerTasks {
    constructor(private readonly _server: Server) {}

    /**
     * Sends a request and returns an AsyncGenerator that yields response messages.
     * The generator is guaranteed to end with either a 'result' or 'error' message.
     *
     * This method provides streaming access to request processing, allowing you to
     * observe intermediate task status updates for task-augmented requests.
     *
     * @param request - The request to send
     * @param resultSchema - Zod schema for validating the result
     * @param options - Optional request options (timeout, signal, task creation params, etc.)
     * @returns AsyncGenerator that yields ResponseMessage objects
     *
     * @experimental
     */
    requestStream<T extends AnyObjectSchema>(
        request: Request,
        resultSchema: T,
        options?: RequestOptions
    ): AsyncGenerator<ResponseMessage<SchemaOutput<T> & Result>, void, void> {
        return this._server.tasks.requestStream(request, resultSchema, options) as AsyncGenerator<
            ResponseMessage<SchemaOutput<T> & Result>,
            void,
            void
        >;
    }

    /**
     * Gets the current status of a task.
     *
     * @param taskId - The task identifier
     * @param options - Optional request options
     * @returns The task status
     *
     * @experimental
     */
    async getTask(taskId: string, options?: RequestOptions): Promise<GetTaskResult> {
        return this._server.tasks.getTask({ taskId }, options);
    }

    /**
     * Retrieves the result of a completed task.
     *
     * @param taskId - The task identifier
     * @param resultSchema - Zod schema for validating the result
     * @param options - Optional request options
     * @returns The task result
     *
     * @experimental
     */
    async getTaskResult<T extends AnySchema>(taskId: string, resultSchema?: T, options?: RequestOptions): Promise<SchemaOutput<T>> {
        return this._server.tasks.getTaskResult({ taskId }, resultSchema!, options);
    }

    /**
     * Lists tasks with optional pagination.
     *
     * @param cursor - Optional pagination cursor
     * @param options - Optional request options
     * @returns List of tasks with optional next cursor
     *
     * @experimental
     */
    async listTasks(cursor?: string, options?: RequestOptions): Promise<ListTasksResult> {
        return this._server.tasks.listTasks(cursor ? { cursor } : undefined, options);
    }

    /**
     * Cancels a running task.
     *
     * @param taskId - The task identifier
     * @param options - Optional request options
     *
     * @experimental
     */
    async cancelTask(taskId: string, options?: RequestOptions): Promise<CancelTaskResult> {
        return this._server.tasks.cancelTask({ taskId }, options);
    }
}
