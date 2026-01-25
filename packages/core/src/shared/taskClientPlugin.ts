/**
 * Task Client Plugin
 *
 * This plugin provides client-side methods for calling task APIs on a remote server.
 * It also manages task-related progress handlers.
 *
 * Usage:
 * ```typescript
 * const taskClient = client.getPlugin(TaskClientPlugin);
 * const task = await taskClient?.getTask({ taskId: 'task-123' });
 * ```
 */

import { isTerminal } from '../experimental/tasks/interfaces.js';
import type {
    CancelTaskResult,
    GetTaskPayloadRequest,
    GetTaskRequest,
    GetTaskResult,
    JSONRPCErrorResponse,
    JSONRPCNotification,
    JSONRPCRequest,
    JSONRPCResponse,
    ListTasksResult,
    RelatedTaskMetadata,
    Request,
    Result,
    TaskCreationParams
} from '../types/types.js';
import {
    CancelTaskResultSchema,
    CreateTaskResultSchema,
    ErrorCode,
    GetTaskResultSchema,
    isJSONRPCResultResponse,
    ListTasksResultSchema,
    McpError,
    RELATED_TASK_META_KEY
} from '../types/types.js';
import type { AnySchema, SchemaOutput } from '../util/zodCompat.js';
import type { OutgoingNotificationContext, OutgoingRequestContext, PluginContext, PluginRequestOptions, ProtocolPlugin } from './plugin.js';
import type { ProgressCallback, ProgressManagerInterface } from './progressManager.js';
import type { RequestOptions } from './protocol.js';
import type { ResponseMessage } from './responseMessage.js';

// ═══════════════════════════════════════════════════════════════════════════
// Task-Specific Option Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extended request options for task-augmented requests.
 *
 * Use these options when sending requests that should create or relate to tasks.
 * For type safety at call sites, use `satisfies TaskRequestOptions`:
 *
 * @example
 * ```typescript
 * import type { TaskRequestOptions } from '@modelcontextprotocol/core';
 *
 * // Create a task with the request
 * await client.request(callToolRequest, CallToolResultSchema, {
 *     task: { ttl: 60000 }
 * } satisfies TaskRequestOptions);
 *
 * // Inside a handler, associate with a parent task
 * await ctx.sendRequest(req, schema, {
 *     relatedTask: { taskId: ctx.taskCtx?.id }
 * } satisfies TaskRequestOptions);
 * ```
 */
export type TaskRequestOptions = RequestOptions & {
    /**
     * If provided, augments the request with task creation parameters
     * to enable call-now, fetch-later execution patterns.
     */
    task?: TaskCreationParams;

    /**
     * If provided, associates this request with a related task.
     * This is typically set internally by the SDK when handling task-augmented requests.
     */
    relatedTask?: RelatedTaskMetadata;
};

/**
 * Extended notification options for task-related notifications.
 *
 * Use these options when sending notifications that should be associated with a task.
 * For type safety at call sites, use `satisfies TaskNotificationOptions`:
 *
 * @example
 * ```typescript
 * import type { TaskNotificationOptions } from '@modelcontextprotocol/core';
 *
 * // Inside a handler, associate notification with a parent task
 * await ctx.sendNotification(progressNotification, {
 *     relatedTask: { taskId: ctx.taskCtx?.id }
 * } satisfies TaskNotificationOptions);
 * ```
 */
export type TaskNotificationOptions = {
    /**
     * If provided, associates this notification with a related task.
     * This is typically set internally by the SDK when handling task-augmented requests.
     */
    relatedTask?: RelatedTaskMetadata;
};

/**
 * Plugin that provides client-side task API methods.
 * Clients access this via getPlugin(TaskClientPlugin) to call task APIs on remote servers.
 */
export class TaskClientPlugin implements ProtocolPlugin<Result> {
    readonly name = 'TaskClientPlugin';
    readonly priority = 50; // Standard priority

    private ctx?: PluginContext<Result>;
    private progressManager?: ProgressManagerInterface;

    /**
     * Maps task IDs to their associated progress token (message ID) and handler.
     * This allows progress to continue after CreateTaskResult is returned.
     */
    private readonly taskProgressHandlers = new Map<string, { messageId: number; handler: ProgressCallback }>();

    /**
     * Install the plugin.
     */
    install(ctx: PluginContext<Result>): void {
        this.ctx = ctx;
        this.progressManager = ctx.progress;
    }

    /**
     * Called when a response is received for an outgoing request.
     * Detects task creation responses and preserves progress handlers.
     */
    onResponse(response: JSONRPCResponse | JSONRPCErrorResponse, messageId: number): void {
        if (!this.progressManager) return;

        // Check if this is a CreateTaskResult response
        if (isJSONRPCResultResponse(response) && response.result && typeof response.result === 'object') {
            const result = response.result as Record<string, unknown>;
            if (result.task && typeof result.task === 'object') {
                const task = result.task as Record<string, unknown>;
                if (typeof task.taskId === 'string') {
                    const taskId = task.taskId;

                    // Get the current progress handler before Protocol removes it
                    const handler = this.progressManager.getHandler(messageId);
                    if (handler) {
                        // Store the handler for this task
                        this.taskProgressHandlers.set(taskId, { messageId, handler });

                        // Re-register the handler so it stays active
                        // This is called before Protocol.removeHandler, so we need to
                        // re-register after Protocol removes it. We do this by
                        // scheduling it on next tick.
                        queueMicrotask(() => {
                            this.progressManager?.registerHandler(messageId, handler);
                        });
                    }
                }
            }
        }
    }

    /**
     * Clears the progress handler for a completed task.
     * Call this when a task reaches terminal state.
     *
     * @param taskId - The task ID whose progress handler should be removed
     */
    clearTaskProgress(taskId: string): void {
        const entry = this.taskProgressHandlers.get(taskId);
        if (entry) {
            this.progressManager?.removeHandler(entry.messageId);
            this.taskProgressHandlers.delete(taskId);
        }
    }

    /**
     * Checks if a task has an active progress handler.
     */
    hasTaskProgress(taskId: string): boolean {
        return this.taskProgressHandlers.has(taskId);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Outgoing Message Hooks
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Augments outgoing requests with task metadata.
     * - Adds task creation params if `task` option is provided
     * - Adds related task metadata if `relatedTask` option is provided
     * - Registers response resolver for task-related requests
     */
    onBeforeSendRequest(request: JSONRPCRequest, ctx: OutgoingRequestContext): JSONRPCRequest | void {
        // Read task-specific options from the raw options object
        const options = ctx.requestOptions as TaskRequestOptions | undefined;
        if (!options) return;

        let modified = request;
        const { task, relatedTask } = options;

        // Augment with task creation parameters if provided
        if (task) {
            modified = {
                ...modified,
                params: {
                    ...modified.params,
                    task
                }
            };
        }

        // Augment with related task metadata if provided
        if (relatedTask) {
            const existingParams = (modified.params ?? {}) as Record<string, unknown>;
            const existingMeta = (existingParams._meta ?? {}) as Record<string, unknown>;
            modified = {
                ...modified,
                params: {
                    ...existingParams,
                    _meta: {
                        ...existingMeta,
                        [RELATED_TASK_META_KEY]: relatedTask
                    }
                }
            };

            // Register resolver for task-related requests so responses route back
            ctx.registerResolver(() => {
                // The resolver is registered automatically by Protocol
            });
        }

        // Return modified request if changes were made
        if (modified === request) {
            return undefined;
        }
        return modified;
    }

    /**
     * Augments outgoing notifications with task metadata.
     * Adds related task metadata if `relatedTask` option is provided.
     */
    onBeforeSendNotification(notification: JSONRPCNotification, ctx: OutgoingNotificationContext): JSONRPCNotification | void {
        // Read task-specific options from the raw options object
        const options = ctx.notificationOptions as TaskNotificationOptions | undefined;
        if (!options?.relatedTask) return;

        const existingParams = (notification.params ?? {}) as Record<string, unknown>;
        const existingMeta = (existingParams._meta ?? {}) as Record<string, unknown>;
        const modified = {
            ...notification,
            params: {
                ...existingParams,
                _meta: {
                    ...existingMeta,
                    [RELATED_TASK_META_KEY]: options.relatedTask
                }
            }
        };

        return modified;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Task API Methods
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Gets the current status of a task.
     */
    async getTask(params: GetTaskRequest['params'], options?: PluginRequestOptions): Promise<GetTaskResult> {
        if (!this.ctx) {
            throw new Error('TaskClientPlugin not installed');
        }
        return this.ctx.requests.sendRequest({ jsonrpc: '2.0', id: 0, method: 'tasks/get', params }, GetTaskResultSchema, options);
    }

    /**
     * Retrieves the result of a completed task.
     * Uses long-polling to wait for task completion.
     */
    async getTaskResult<T extends AnySchema>(
        params: GetTaskPayloadRequest['params'],
        resultSchema: T,
        options?: PluginRequestOptions
    ): Promise<SchemaOutput<T>> {
        if (!this.ctx) {
            throw new Error('TaskClientPlugin not installed');
        }
        const result = await this.ctx.requests.sendRequest(
            { jsonrpc: '2.0', id: 0, method: 'tasks/result', params },
            resultSchema,
            options
        );

        // Clear progress handler when task result is retrieved
        this.clearTaskProgress(params.taskId);

        return result;
    }

    /**
     * Lists all tasks, optionally with pagination.
     */
    async listTasks(params?: { cursor?: string }, options?: PluginRequestOptions): Promise<ListTasksResult> {
        if (!this.ctx) {
            throw new Error('TaskClientPlugin not installed');
        }
        return this.ctx.requests.sendRequest({ jsonrpc: '2.0', id: 0, method: 'tasks/list', params }, ListTasksResultSchema, options);
    }

    /**
     * Cancels a running task.
     */
    async cancelTask(params: { taskId: string }, options?: PluginRequestOptions): Promise<CancelTaskResult> {
        if (!this.ctx) {
            throw new Error('TaskClientPlugin not installed');
        }
        const result = await this.ctx.requests.sendRequest(
            { jsonrpc: '2.0', id: 0, method: 'tasks/cancel', params },
            CancelTaskResultSchema,
            options
        );

        // Clear progress handler when task is cancelled
        this.clearTaskProgress(params.taskId);

        return result;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Task Streaming
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Sends a task-augmented request and streams status updates until completion.
     * This handles the full task lifecycle: creation, polling, and result retrieval.
     *
     * @param request - The request to send (method and params)
     * @param resultSchema - Schema to validate the final result
     * @param options - Options including task creation params
     * @yields ResponseMessage events for task creation, status updates, and final result/error
     */
    async *requestStream<T extends AnySchema>(
        request: Request,
        resultSchema: T,
        options: TaskClientRequestStreamOptions
    ): AsyncGenerator<ResponseMessage<SchemaOutput<T>>, void, void> {
        if (!this.ctx) {
            throw new Error('TaskClientPlugin not installed');
        }

        let taskId: string | undefined;
        try {
            // Send the request and get the CreateTaskResult
            // Convert Request to JSONRPCRequest format for sendRequest
            const jsonRpcRequest = { jsonrpc: '2.0' as const, id: 0, ...request };
            const createResult = await this.ctx.requests.sendRequest(jsonRpcRequest, CreateTaskResultSchema, options);

            // Extract taskId from the result
            if (createResult.task) {
                taskId = createResult.task.taskId;
                yield { type: 'taskCreated', task: createResult.task };
            } else {
                throw new McpError(ErrorCode.InternalError, 'Task creation did not return a task');
            }

            // Poll for task completion
            while (true) {
                // Get current task status
                const task = await this.getTask({ taskId }, options);
                yield { type: 'taskStatus', task };

                // Check if task is terminal
                if (isTerminal(task.status)) {
                    switch (task.status) {
                        case 'completed': {
                            // Get the final result
                            const result = await this.getTaskResult({ taskId }, resultSchema, options);
                            yield { type: 'result', result };
                            break;
                        }
                        case 'failed': {
                            yield {
                                type: 'error',
                                error: new McpError(ErrorCode.InternalError, `Task ${taskId} failed`)
                            };
                            break;
                        }
                        case 'cancelled': {
                            yield {
                                type: 'error',
                                error: new McpError(ErrorCode.InternalError, `Task ${taskId} was cancelled`)
                            };
                            break;
                        }
                        // No default
                    }
                    return;
                }

                // When input_required, call tasks/result to deliver queued messages
                // (elicitation, sampling) via SSE and block until terminal
                if (task.status === 'input_required') {
                    const result = await this.getTaskResult({ taskId }, resultSchema, options);
                    yield { type: 'result', result };
                    return;
                }

                // Wait before polling again
                const pollInterval = task.pollInterval ?? options.defaultPollInterval ?? 1000;
                await new Promise(resolve => setTimeout(resolve, pollInterval));

                // Check if cancelled
                options.signal?.throwIfAborted();
            }
        } catch (error) {
            yield {
                type: 'error',
                error: error instanceof McpError ? error : new McpError(ErrorCode.InternalError, String(error))
            };
        }
    }
}

/**
 * Options for TaskClientPlugin.requestStream.
 */
export interface TaskClientRequestStreamOptions extends PluginRequestOptions {
    task: TaskCreationParams;
    defaultPollInterval?: number;
}

/**
 * Factory function to create a TaskClientPlugin.
 */
export function createTaskClientPlugin(): TaskClientPlugin {
    return new TaskClientPlugin();
}
