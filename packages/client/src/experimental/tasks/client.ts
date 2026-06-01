/**
 * Experimental client task features for MCP SDK.
 * WARNING: These APIs are experimental and may change without notice.
 *
 * @experimental
 */

import type {
    AnyObjectSchema,
    CallToolRequest,
    CallToolResult,
    CancelTaskResult,
    CreateTaskResult,
    GetTaskPayloadResult,
    GetTaskResult,
    ListTasksResult,
    Request,
    RequestMethod,
    RequestOptions,
    ResponseMessage,
    ResultTypeMap,
    TaskPartialNotification,
    TaskPartialNotificationParams
} from '@modelcontextprotocol/core';
import {
    CallToolResultSchema,
    getResultSchema,
    GetTaskPayloadResultSchema,
    ProtocolError,
    ProtocolErrorCode,
    TaskPartialNotificationParamsSchema
} from '@modelcontextprotocol/core';

import type { Client } from '../../client/client.js';

/**
 * Internal interface for accessing {@linkcode Client}'s private methods.
 * @internal
 */
interface ClientInternal {
    isToolTask(toolName: string): boolean;
    getToolOutputValidator(toolName: string): ((data: unknown) => { valid: boolean; errorMessage?: string }) | undefined;
}

/**
 * Experimental task features for MCP clients.
 *
 * Access via `client.experimental.tasks`:
 * ```typescript
 * const stream = client.experimental.tasks.callToolStream({ name: 'tool', arguments: {} });
 * const task = await client.experimental.tasks.getTask(taskId);
 * ```
 *
 * @experimental
 */
export class ExperimentalClientTasks {
    private _partialSubscriptions = new Map<
        string,
        {
            handler: (params: TaskPartialNotificationParams) => void;
            lastSeq: number;
        }
    >();

    constructor(private readonly _client: Client) {
        // Register notification handler for notifications/tasks/partial
        this._client.setNotificationHandler('notifications/tasks/partial', (notification: TaskPartialNotification) => {
            this._handlePartialNotification(notification);
        });
    }

    private get _module() {
        return this._client.taskManager;
    }

    /**
     * Calls a tool and returns an AsyncGenerator that yields response messages.
     * The generator is guaranteed to end with either a `'result'` or `'error'` message.
     *
     * This method provides streaming access to tool execution, allowing you to
     * observe intermediate task status updates for long-running tool calls.
     * Automatically validates structured output if the tool has an `outputSchema`.
     *
     * @example
     * ```ts source="./client.examples.ts#ExperimentalClientTasks_callToolStream"
     * const stream = client.experimental.tasks.callToolStream({ name: 'myTool', arguments: {} });
     * for await (const message of stream) {
     *     switch (message.type) {
     *         case 'taskCreated': {
     *             console.log('Tool execution started:', message.task.taskId);
     *             break;
     *         }
     *         case 'taskStatus': {
     *             console.log('Tool status:', message.task.status);
     *             break;
     *         }
     *         case 'result': {
     *             console.log('Tool result:', message.result);
     *             break;
     *         }
     *         case 'error': {
     *             console.error('Tool error:', message.error);
     *             break;
     *         }
     *     }
     * }
     * ```
     *
     * @param params - Tool call parameters (name and arguments)
     * @param options - Optional request options (timeout, signal, task creation params, etc.)
     * @returns AsyncGenerator that yields {@linkcode ResponseMessage} objects
     *
     * @experimental
     */
    async *callToolStream(
        params: CallToolRequest['params'],
        options?: RequestOptions
    ): AsyncGenerator<ResponseMessage<CallToolResult | CreateTaskResult>, void, void> {
        // Access Client's internal methods
        const clientInternal = this._client as unknown as ClientInternal;

        // Add task creation parameters if server supports it and not explicitly provided
        const optionsWithTask = {
            ...options,
            // We check if the tool is known to be a task during auto-configuration, but assume
            // the caller knows what they're doing if they pass this explicitly
            task: options?.task ?? (clientInternal.isToolTask(params.name) ? {} : undefined)
        };

        const stream = this._module.requestStream({ method: 'tools/call', params }, CallToolResultSchema, optionsWithTask);

        // Get the validator for this tool (if it has an output schema)
        const validator = clientInternal.getToolOutputValidator(params.name);

        // Iterate through the stream and validate the final result if needed
        for await (const message of stream) {
            // If this is a result message and the tool has an output schema, validate it
            // Only validate CallToolResult (has 'content'), not CreateTaskResult (has 'task')
            if (message.type === 'result' && validator && 'content' in message.result) {
                const result = message.result as CallToolResult;

                // If tool has outputSchema, it MUST return structuredContent (unless it's an error)
                if (!result.structuredContent && !result.isError) {
                    yield {
                        type: 'error',
                        error: new ProtocolError(
                            ProtocolErrorCode.InvalidRequest,
                            `Tool ${params.name} has an output schema but did not return structured content`
                        )
                    };
                    return;
                }

                // Only validate structured content if present (not when there's an error)
                if (result.structuredContent) {
                    try {
                        // Validate the structured content against the schema
                        const validationResult = validator(result.structuredContent);

                        if (!validationResult.valid) {
                            yield {
                                type: 'error',
                                error: new ProtocolError(
                                    ProtocolErrorCode.InvalidParams,
                                    `Structured content does not match the tool's output schema: ${validationResult.errorMessage}`
                                )
                            };
                            return;
                        }
                    } catch (error) {
                        if (error instanceof ProtocolError) {
                            yield { type: 'error', error };
                            return;
                        }
                        yield {
                            type: 'error',
                            error: new ProtocolError(
                                ProtocolErrorCode.InvalidParams,
                                `Failed to validate structured content: ${error instanceof Error ? error.message : String(error)}`
                            )
                        };
                        return;
                    }
                }
            }

            // Yield the message (either validated result or any other message type)
            yield message;
        }
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
        return this._module.getTask({ taskId }, options);
    }

    /**
     * Retrieves the result of a completed task.
     *
     * @param taskId - The task identifier
     * @param options - Optional request options
     * @returns The task result. The payload structure matches the result type of the
     *   original request (e.g., a `tools/call` task returns a `CallToolResult`).
     *
     * @experimental
     */
    async getTaskResult(taskId: string, options?: RequestOptions): Promise<GetTaskPayloadResult> {
        return this._module.getTaskResult({ taskId }, GetTaskPayloadResultSchema, options);
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
        return this._module.listTasks(cursor ? { cursor } : undefined, options);
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
        return this._module.cancelTask({ taskId }, options);
    }

    /**
     * Subscribes to partial result notifications for a specific task.
     *
     * Registers a callback that receives `notifications/tasks/partial` notifications
     * matching the given taskId. Notifications are delivered with automatic seq-based
     * ordering and duplicate detection:
     * - Sequential notifications (seq === lastSeq + 1) are delivered normally
     * - Duplicate notifications (seq <= lastSeq) are silently discarded
     * - Gap notifications (seq > lastSeq + 1) are delivered with a warning logged
     *
     * @param taskId - The task identifier to subscribe to
     * @param handler - Callback receiving parsed {@linkcode TaskPartialNotificationParams} for each matching notification
     * @returns Cleanup function that, when called, removes the subscription and stops delivery
     *
     * @experimental
     */
    subscribeTaskPartials(taskId: string, handler: (params: TaskPartialNotificationParams) => void): () => void {
        this._partialSubscriptions.set(taskId, { handler, lastSeq: -1 });
        return () => {
            this._partialSubscriptions.delete(taskId);
        };
    }

    /**
     * Handles incoming `notifications/tasks/partial` notifications.
     *
     * Parses the notification params, routes by taskId, and applies seq-based
     * ordering and deduplication before delivering to the subscription handler.
     */
    private _handlePartialNotification(notification: TaskPartialNotification): void {
        // 1. Parse params via TaskPartialNotificationParamsSchema
        const parseResult = TaskPartialNotificationParamsSchema.safeParse(notification.params);
        if (!parseResult.success) {
            this._client.onerror?.(new Error(`Invalid notifications/tasks/partial params: ${parseResult.error}`));
            return;
        }

        const params = parseResult.data as TaskPartialNotificationParams;

        // 2. Look up subscription by taskId; discard silently if no subscription
        const subscription = this._partialSubscriptions.get(params.taskId);
        if (!subscription) {
            return;
        }

        // 3. Apply seq-based ordering and deduplication
        const { seq } = params;
        const { lastSeq } = subscription;

        if (seq <= lastSeq) {
            // Duplicate — discard silently
            return;
        }

        if (lastSeq === -1 && seq > 0) {
            // First notification with seq > 0 — warn about missed initial partials
            this._client.onerror?.(
                new Error(
                    `Task "${params.taskId}": first partial notification has seq=${seq}, expected 0. ` +
                        'Potential missed initial partials.'
                )
            );
        } else if (seq > lastSeq + 1) {
            // Gap detected — warn about potential data loss
            this._client.onerror?.(
                new Error(`Task "${params.taskId}": seq gap detected (expected ${lastSeq + 1}, got ${seq}). ` + 'Potential data loss.')
            );
        }

        // Deliver to handler and update lastSeq
        subscription.lastSeq = seq;
        subscription.handler(params);
    }

    /**
     * Sends a request and returns an AsyncGenerator that yields response messages.
     * The generator is guaranteed to end with either a `'result'` or `'error'` message.
     *
     * This method provides streaming access to request processing, allowing you to
     * observe intermediate task status updates for task-augmented requests.
     *
     * @example
     * ```ts source="./client.examples.ts#ExperimentalClientTasks_requestStream"
     * const stream = client.experimental.tasks.requestStream({ method: 'tools/call', params: { name: 'my-tool', arguments: {} } }, options);
     * for await (const message of stream) {
     *     switch (message.type) {
     *         case 'taskCreated': {
     *             console.log('Task created:', message.task.taskId);
     *             break;
     *         }
     *         case 'taskStatus': {
     *             console.log('Task status:', message.task.status);
     *             break;
     *         }
     *         case 'result': {
     *             console.log('Final result:', message.result);
     *             break;
     *         }
     *         case 'error': {
     *             console.error('Error:', message.error);
     *             break;
     *         }
     *     }
     * }
     * ```
     *
     * @param request - The request to send
     * @param options - Optional request options (timeout, signal, task creation params, etc.)
     * @returns AsyncGenerator that yields {@linkcode ResponseMessage} objects
     *
     * @experimental
     */
    requestStream<M extends RequestMethod>(
        request: { method: M; params?: Record<string, unknown> },
        options?: RequestOptions
    ): AsyncGenerator<ResponseMessage<ResultTypeMap[M]>, void, void> {
        const resultSchema = getResultSchema(request.method) as unknown as AnyObjectSchema;
        return this._module.requestStream(request as Request, resultSchema, options) as AsyncGenerator<
            ResponseMessage<ResultTypeMap[M]>,
            void,
            void
        >;
    }
}
