/**
 * Experimental server task features for MCP SDK.
 * WARNING: These APIs are experimental and may change without notice.
 *
 * @experimental
 */

import type {
    AnySchema,
    CancelTaskResult,
    CreateMessageRequestParams,
    CreateMessageResult,
    ElicitRequestFormParams,
    ElicitRequestURLParams,
    ElicitResult,
    GetTaskResult,
    ListTasksResult,
    Request,
    RequestOptions,
    ResponseMessage,
    Result,
    SchemaOutput
} from '@modelcontextprotocol/core';
import { CreateMessageResultSchema, ElicitResultSchema } from '@modelcontextprotocol/core';

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
    requestStream<T extends AnySchema>(
        request: Request,
        resultSchema: T,
        options?: RequestOptions
    ): AsyncGenerator<ResponseMessage<SchemaOutput<T> & Result>, void, void> {
        // Delegate to the server's underlying Protocol method
        type ServerWithRequestStream = {
            requestStream<U extends AnySchema>(
                request: Request,
                resultSchema: U,
                options?: RequestOptions
            ): AsyncGenerator<ResponseMessage<SchemaOutput<U> & Result>, void, void>;
        };
        return (this._server as unknown as ServerWithRequestStream).requestStream(request, resultSchema, options);
    }

    /**
     * Sends a sampling request and returns an AsyncGenerator that yields response messages.
     * The generator is guaranteed to end with either a 'result' or 'error' message.
     *
     * For task-augmented requests, yields 'taskCreated' and 'taskStatus' messages
     * before the final result.
     *
     * @example
     * ```typescript
     * const stream = server.experimental.tasks.createMessageStream({
     *     messages: [{ role: 'user', content: { type: 'text', text: 'Hello' } }],
     *     maxTokens: 100
     * }, {
     *     onprogress: (progress) => {
     *         // Handle streaming tokens via progress notifications
     *         console.log('Progress:', progress.message);
     *     }
     * });
     *
     * for await (const message of stream) {
     *     switch (message.type) {
     *         case 'taskCreated':
     *             console.log('Task created:', message.task.taskId);
     *             break;
     *         case 'taskStatus':
     *             console.log('Task status:', message.task.status);
     *             break;
     *         case 'result':
     *             console.log('Final result:', message.result);
     *             break;
     *         case 'error':
     *             console.error('Error:', message.error);
     *             break;
     *     }
     * }
     * ```
     *
     * @param params - The sampling request parameters
     * @param options - Optional request options (timeout, signal, task creation params, onprogress, etc.)
     * @returns AsyncGenerator that yields ResponseMessage objects
     *
     * @experimental
     */
    createMessageStream(
        params: CreateMessageRequestParams,
        options?: RequestOptions
    ): AsyncGenerator<ResponseMessage<CreateMessageResult>, void, void> {
        // Access client capabilities via the server
        const clientCapabilities = this._server.getClientCapabilities();

        // Capability check - only required when tools/toolChoice are provided
        if ((params.tools || params.toolChoice) && !clientCapabilities?.sampling?.tools) {
            throw new Error('Client does not support sampling tools capability.');
        }

        // Message structure validation - always validate tool_use/tool_result pairs.
        // These may appear even without tools/toolChoice in the current request when
        // a previous sampling request returned tool_use and this is a follow-up with results.
        if (params.messages.length > 0) {
            const lastMessage = params.messages.at(-1)!;
            const lastContent = Array.isArray(lastMessage.content) ? lastMessage.content : [lastMessage.content];
            const hasToolResults = lastContent.some(c => c.type === 'tool_result');

            const previousMessage = params.messages.length > 1 ? params.messages.at(-2) : undefined;
            const previousContent = previousMessage
                ? Array.isArray(previousMessage.content)
                    ? previousMessage.content
                    : [previousMessage.content]
                : [];
            const hasPreviousToolUse = previousContent.some(c => c.type === 'tool_use');

            if (hasToolResults) {
                if (lastContent.some(c => c.type !== 'tool_result')) {
                    throw new Error('The last message must contain only tool_result content if any is present');
                }
                if (!hasPreviousToolUse) {
                    throw new Error('tool_result blocks are not matching any tool_use from the previous message');
                }
            }
            if (hasPreviousToolUse) {
                const toolUseIds = new Set(previousContent.filter(c => c.type === 'tool_use').map(c => c.id));
                const toolResultIds = new Set(lastContent.filter(c => c.type === 'tool_result').map(c => c.toolUseId));
                if (toolUseIds.size !== toolResultIds.size || ![...toolUseIds].every(id => toolResultIds.has(id))) {
                    throw new Error('ids of tool_result blocks and tool_use blocks from previous message do not match');
                }
            }
        }

        return this.requestStream(
            {
                method: 'sampling/createMessage',
                params
            },
            CreateMessageResultSchema,
            options
        );
    }

    /**
     * Sends an elicitation request and returns an AsyncGenerator that yields response messages.
     * The generator is guaranteed to end with either a 'result' or 'error' message.
     *
     * For task-augmented requests (especially URL-based elicitation), yields 'taskCreated'
     * and 'taskStatus' messages before the final result.
     *
     * @example
     * ```typescript
     * const stream = server.experimental.tasks.elicitInputStream({
     *     mode: 'url',
     *     message: 'Please authenticate',
     *     elicitationId: 'auth-123',
     *     url: 'https://example.com/auth'
     * }, {
     *     task: { ttl: 300000 } // Task-augmented for long-running auth flow
     * });
     *
     * for await (const message of stream) {
     *     switch (message.type) {
     *         case 'taskCreated':
     *             console.log('Task created:', message.task.taskId);
     *             break;
     *         case 'taskStatus':
     *             console.log('Task status:', message.task.status);
     *             break;
     *         case 'result':
     *             console.log('User action:', message.result.action);
     *             break;
     *         case 'error':
     *             console.error('Error:', message.error);
     *             break;
     *     }
     * }
     * ```
     *
     * @param params - The elicitation request parameters
     * @param options - Optional request options (timeout, signal, task creation params, etc.)
     * @returns AsyncGenerator that yields ResponseMessage objects
     *
     * @experimental
     */
    elicitInputStream(
        params: ElicitRequestFormParams | ElicitRequestURLParams,
        options?: RequestOptions
    ): AsyncGenerator<ResponseMessage<ElicitResult>, void, void> {
        // Access client capabilities via the server
        const clientCapabilities = this._server.getClientCapabilities();
        const mode = params.mode ?? 'form';

        // Capability check based on mode
        switch (mode) {
            case 'url': {
                if (!clientCapabilities?.elicitation?.url) {
                    throw new Error('Client does not support url elicitation.');
                }
                break;
            }
            case 'form': {
                if (!clientCapabilities?.elicitation?.form) {
                    throw new Error('Client does not support form elicitation.');
                }
                break;
            }
        }

        // Normalize params to ensure mode is set
        const normalizedParams = mode === 'form' && params.mode !== 'form' ? { ...params, mode: 'form' } : params;
        return this.requestStream(
            {
                method: 'elicitation/create',
                params: normalizedParams
            },
            ElicitResultSchema,
            options
        );
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
        type ServerWithGetTask = { getTask(params: { taskId: string }, options?: RequestOptions): Promise<GetTaskResult> };
        return (this._server as unknown as ServerWithGetTask).getTask({ taskId }, options);
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
        return (
            this._server as unknown as {
                getTaskResult: <U extends AnySchema>(
                    params: { taskId: string },
                    resultSchema?: U,
                    options?: RequestOptions
                ) => Promise<SchemaOutput<U>>;
            }
        ).getTaskResult({ taskId }, resultSchema, options);
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
        return (
            this._server as unknown as {
                listTasks: (params?: { cursor?: string }, options?: RequestOptions) => Promise<ListTasksResult>;
            }
        ).listTasks(cursor ? { cursor } : undefined, options);
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
        return (
            this._server as unknown as {
                cancelTask: (params: { taskId: string }, options?: RequestOptions) => Promise<CancelTaskResult>;
            }
        ).cancelTask({ taskId }, options);
    }
}
