/**
 * Task Plugin
 *
 * This plugin completely abstracts all task-related functionality from the Protocol class:
 * - Message routing for task-related messages (queue instead of send)
 * - Task API handlers (tasks/get, tasks/result, tasks/list, tasks/cancel)
 * - Task message queue management
 *
 * The plugin is internal to the SDK and not exposed as a public API.
 */

import { RequestTaskStore } from '../experimental/requestTaskStore.js';
import type { QueuedMessage, TaskMessageQueue, TaskStore } from '../experimental/tasks/interfaces.js';
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
    JSONRPCResultResponse,
    ListTasksResult,
    RequestId,
    Result
} from '../types/types.js';
import {
    CancelTaskRequestSchema,
    ErrorCode,
    GetTaskPayloadRequestSchema,
    GetTaskRequestSchema,
    isJSONRPCRequest,
    isTaskAugmentedRequestParams,
    ListTasksRequestSchema,
    McpError,
    RELATED_TASK_META_KEY
} from '../types/types.js';
import type { HandlerContextBase, PluginContext, PluginHandlerExtra, ProtocolPlugin } from './plugin.js';
import type { Transport, TransportSendOptions } from './transport.js';

/**
 * Configuration for the TaskPlugin.
 */
export interface TaskPluginConfig {
    /**
     * The task store implementation for persisting task state.
     */
    readonly taskStore: TaskStore;

    /**
     * Optional message queue for async message delivery during task execution.
     */
    readonly taskMessageQueue?: TaskMessageQueue;

    /**
     * Default polling interval (in milliseconds) for task status checks.
     * Defaults to 1000ms if not specified.
     */
    readonly defaultTaskPollInterval?: number;

    /**
     * Maximum number of messages that can be queued per task.
     * If undefined, the queue size is unbounded.
     */
    readonly maxTaskQueueSize?: number;
}

/**
 * Plugin that handles all task-related MCP operations.
 * This completely abstracts task functionality from the Protocol class.
 */
export class TaskPlugin implements ProtocolPlugin<Result> {
    readonly name = 'TaskPlugin';
    readonly priority = 100; // High priority to run before other plugins

    private ctx?: PluginContext<Result>;
    private transport?: Transport;

    constructor(private readonly config: TaskPluginConfig) {}

    // ═══════════════════════════════════════════════════════════════════════════
    // Plugin Lifecycle
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Install the plugin by registering task request handlers.
     */
    install(ctx: PluginContext<Result>): void {
        this.ctx = ctx;

        // Register tasks/get handler
        ctx.handlers.setRequestHandler(GetTaskRequestSchema, async (request, extra) => {
            return this.handleGetTask(request, extra);
        });

        // Register tasks/result handler
        ctx.handlers.setRequestHandler(GetTaskPayloadRequestSchema, async (request, extra) => {
            return this.handleGetTaskPayload(request, extra);
        });

        // Register tasks/list handler
        ctx.handlers.setRequestHandler(ListTasksRequestSchema, async (request, extra) => {
            return this.handleListTasks(request.params, extra);
        });

        // Register tasks/cancel handler
        ctx.handlers.setRequestHandler(CancelTaskRequestSchema, async (request, extra) => {
            return this.handleCancelTask(request.params, extra);
        });
    }

    /**
     * Called when transport connects.
     */
    onConnect(transport: Transport): void {
        this.transport = transport;
    }

    /**
     * Called when connection closes.
     */
    onClose(): void {
        this.transport = undefined;
    }

    /**
     * Called before a request is processed.
     * Checks if task creation is supported for the request method.
     */
    onRequest(request: JSONRPCRequest): JSONRPCRequest | void {
        // If this request asks for task creation, check capability
        const taskCreationParams = isTaskAugmentedRequestParams(request.params) ? request.params.task : undefined;
        if (taskCreationParams) {
            // Check if this method supports task creation
            // For now, we support tasks for tools/call and sampling/createMessage
            const taskCapableMethods = ['tools/call', 'sampling/createMessage'];
            if (!taskCapableMethods.includes(request.method)) {
                throw new McpError(ErrorCode.InvalidRequest, `Task creation is not supported for method: ${request.method}`);
            }
        }
        // Return void to pass through unchanged
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Message Routing
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Extracts the relatedTaskId from a message's _meta field.
     */
    private extractRelatedTaskId(
        message: JSONRPCRequest | JSONRPCNotification | JSONRPCResponse | JSONRPCErrorResponse
    ): string | undefined {
        // For requests/notifications, check params._meta
        if ('method' in message && 'params' in message && message.params) {
            const params = message.params as Record<string, unknown>;
            const meta = params._meta as Record<string, unknown> | undefined;
            const taskMeta = meta?.[RELATED_TASK_META_KEY] as { taskId?: string } | undefined;
            return taskMeta?.taskId;
        }
        return undefined;
    }

    /**
     * Determines if this plugin should route the message (queue for task delivery).
     * Returns true if the message has a relatedTaskId in its metadata and task queue is configured.
     */
    shouldRouteMessage(
        message: JSONRPCRequest | JSONRPCNotification | JSONRPCResponse | JSONRPCErrorResponse,
        _options?: TransportSendOptions
    ): boolean {
        // Route if there's a related task ID in the message and we have a message queue
        const relatedTaskId = this.extractRelatedTaskId(message);
        return Boolean(relatedTaskId && this.config.taskMessageQueue);
    }

    /**
     * Routes the message by queueing it for task delivery.
     */
    async routeMessage(
        message: JSONRPCRequest | JSONRPCNotification | JSONRPCResponse | JSONRPCErrorResponse,
        options?: TransportSendOptions
    ): Promise<void> {
        const relatedTaskId = this.extractRelatedTaskId(message);
        const sessionId = options?.sessionId;
        if (!relatedTaskId || !this.config.taskMessageQueue) {
            throw new Error('Cannot route message: relatedTaskId or taskMessageQueue not available');
        }

        const timestamp = Date.now();

        // Create properly typed QueuedMessage based on message structure
        let queuedMessage: QueuedMessage;
        if ('method' in message && 'id' in message) {
            queuedMessage = { type: 'request', message: message as JSONRPCRequest, timestamp };
        } else if ('method' in message && !('id' in message)) {
            queuedMessage = { type: 'notification', message: message as JSONRPCNotification, timestamp };
        } else if ('result' in message) {
            queuedMessage = { type: 'response', message: message as JSONRPCResultResponse, timestamp };
        } else {
            queuedMessage = { type: 'error', message: message as JSONRPCErrorResponse, timestamp };
        }

        await this.enqueueTaskMessage(relatedTaskId, queuedMessage, sessionId);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Handler Context Hook
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Builds task context for incoming request handlers.
     * Extracts task creation params and related task metadata from the request,
     * creates a RequestTaskStore, and returns the task context.
     */
    onBuildHandlerContext(request: JSONRPCRequest, baseContext: HandlerContextBase): Record<string, unknown> | undefined {
        // Only build task context if we have a task store configured
        if (!this.config.taskStore) {
            return undefined;
        }

        // Extract task metadata from request
        const relatedTaskId = this.extractRelatedTaskId(request);
        const taskCreationParams = isTaskAugmentedRequestParams(request.params) ? request.params.task : undefined;

        // Create the RequestTaskStore
        const requestTaskStore = new RequestTaskStore({
            taskStore: this.config.taskStore,
            requestId: request.id,
            request,
            sessionId: baseContext.sessionId,
            initialTaskId: relatedTaskId ?? ''
        });

        // Return task context that will be merged into the handler context
        return {
            taskCtx: {
                get id() {
                    return requestTaskStore.currentTaskId;
                },
                store: requestTaskStore,
                requestedTtl: taskCreationParams?.ttl ?? null
            }
        };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Task Message Queue Management
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Enqueues a message for task delivery.
     */
    private async enqueueTaskMessage(taskId: string, message: QueuedMessage, sessionId?: string): Promise<void> {
        if (!this.config.taskMessageQueue) {
            throw new Error('Cannot enqueue task message: taskMessageQueue is not configured');
        }

        await this.config.taskMessageQueue.enqueue(taskId, message, sessionId, this.config.maxTaskQueueSize);
    }

    /**
     * Clears the message queue for a task and rejects any pending request resolvers.
     */
    private async clearTaskQueue(taskId: string, sessionId?: string): Promise<void> {
        if (!this.config.taskMessageQueue || !this.ctx) {
            return;
        }

        // Dequeue all messages and reject pending request resolvers
        const messages = await this.config.taskMessageQueue.dequeueAll(taskId, sessionId);
        for (const message of messages) {
            if (message.type === 'request' && isJSONRPCRequest(message.message)) {
                const requestId = message.message.id as RequestId;
                const resolver = this.ctx.resolvers.get(requestId);
                if (resolver) {
                    resolver(new McpError(ErrorCode.InternalError, 'Task cancelled or completed'));
                    this.ctx.resolvers.remove(requestId);
                } else {
                    this.ctx.reportError(new Error(`Resolver missing for request ${requestId} during task ${taskId} cleanup`));
                }
            }
        }
    }

    /**
     * Waits for a task update (new messages or status change) with abort signal support.
     */
    private async waitForTaskUpdate(taskId: string, signal: AbortSignal): Promise<void> {
        // Get the task's poll interval, falling back to default
        let interval = this.config.defaultTaskPollInterval ?? 1000;
        try {
            const task = await this.config.taskStore.getTask(taskId);
            if (task?.pollInterval) {
                interval = task.pollInterval;
            }
        } catch {
            // Use default interval if task lookup fails
        }

        return new Promise((resolve, reject) => {
            if (signal.aborted) {
                reject(new McpError(ErrorCode.InvalidRequest, 'Request cancelled'));
                return;
            }

            // Wait for the poll interval, then resolve so caller can check for updates
            const timeoutId = setTimeout(resolve, interval);

            // Clean up timeout and reject if aborted
            signal.addEventListener(
                'abort',
                () => {
                    clearTimeout(timeoutId);
                    reject(new McpError(ErrorCode.InvalidRequest, 'Request cancelled'));
                },
                { once: true }
            );
        });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Task API Handlers
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Handler for tasks/get - retrieves task metadata.
     */
    private async handleGetTask(request: GetTaskRequest, extra: PluginHandlerExtra): Promise<GetTaskResult> {
        const task = await this.config.taskStore.getTask(request.params.taskId, extra.mcpCtx.sessionId);
        if (!task) {
            throw new McpError(ErrorCode.InvalidParams, 'Failed to retrieve task: Task not found');
        }

        // Per spec: tasks/get responses SHALL NOT include related-task metadata
        return { ...task };
    }

    /**
     * Handler for tasks/result - delivers task results and queued messages.
     * Implements long-polling pattern for task updates.
     */
    private async handleGetTaskPayload(request: GetTaskPayloadRequest, extra: PluginHandlerExtra): Promise<Result> {
        const taskId = request.params.taskId;

        const poll = async (): Promise<Result> => {
            // Deliver any queued messages first
            await this.deliverQueuedMessages(taskId, extra);

            // Check task status
            const task = await this.config.taskStore.getTask(taskId, extra.mcpCtx.sessionId);
            if (!task) {
                throw new McpError(ErrorCode.InvalidParams, `Task not found: ${taskId}`);
            }

            // If task is not terminal, wait for updates and poll again
            if (!isTerminal(task.status)) {
                await this.waitForTaskUpdate(taskId, extra.requestCtx.signal);
                return poll();
            }

            // Task is terminal - return the result
            const result = await this.config.taskStore.getTaskResult(taskId, extra.mcpCtx.sessionId);
            await this.clearTaskQueue(taskId, extra.mcpCtx.sessionId);

            return {
                ...result,
                _meta: {
                    ...result._meta,
                    [RELATED_TASK_META_KEY]: { taskId }
                }
            };
        };

        return poll();
    }

    /**
     * Delivers queued messages for a task.
     */
    private async deliverQueuedMessages(taskId: string, extra: PluginHandlerExtra): Promise<void> {
        const { taskMessageQueue } = this.config;
        if (!taskMessageQueue || !this.ctx) {
            return;
        }

        let queuedMessage: QueuedMessage | undefined;
        while ((queuedMessage = await taskMessageQueue.dequeue(taskId, extra.mcpCtx.sessionId))) {
            // Handle response and error messages by routing to original resolver
            if (queuedMessage.type === 'response' || queuedMessage.type === 'error') {
                await this.routeQueuedResponse(queuedMessage);
                continue;
            }

            // Send other messages (notifications, requests) on the response stream
            const transport = this.ctx.transport.getTransport();
            await transport?.send(queuedMessage.message, { relatedRequestId: extra.mcpCtx.requestId });
        }
    }

    /**
     * Routes a queued response/error back to its original request resolver.
     */
    private async routeQueuedResponse(queuedMessage: QueuedMessage): Promise<void> {
        if (!this.ctx) return;

        const message = queuedMessage.message as JSONRPCResultResponse | JSONRPCErrorResponse;
        const requestId = message.id as RequestId;

        const resolver = this.ctx.resolvers.get(requestId);
        if (!resolver) {
            const messageType = queuedMessage.type === 'response' ? 'Response' : 'Error';
            this.ctx.reportError(new Error(`${messageType} handler missing for request ${requestId}`));
            return;
        }

        this.ctx.resolvers.remove(requestId);

        if (queuedMessage.type === 'response') {
            resolver(message as JSONRPCResultResponse);
        } else {
            const errorMessage = message as JSONRPCErrorResponse;
            const error = new McpError(errorMessage.error.code, errorMessage.error.message, errorMessage.error.data);
            resolver(error);
        }
    }

    /**
     * Handler for tasks/list - lists all tasks.
     */
    private async handleListTasks(params: { cursor?: string } | undefined, extra: PluginHandlerExtra): Promise<ListTasksResult> {
        try {
            const { tasks, nextCursor } = await this.config.taskStore.listTasks(params?.cursor, extra.mcpCtx.sessionId);
            return { tasks, nextCursor, _meta: {} };
        } catch (error) {
            throw new McpError(ErrorCode.InvalidParams, `Failed to list tasks: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Handler for tasks/cancel - cancels a running task.
     */
    private async handleCancelTask(params: { taskId: string }, extra: PluginHandlerExtra): Promise<CancelTaskResult> {
        try {
            const task = await this.config.taskStore.getTask(params.taskId, extra.mcpCtx.sessionId);

            if (!task) {
                throw new McpError(ErrorCode.InvalidParams, `Task not found: ${params.taskId}`);
            }

            if (isTerminal(task.status)) {
                throw new McpError(ErrorCode.InvalidParams, `Cannot cancel task in terminal status: ${task.status}`);
            }

            await this.config.taskStore.updateTaskStatus(
                params.taskId,
                'cancelled',
                'Client cancelled task execution.',
                extra.mcpCtx.sessionId
            );

            await this.clearTaskQueue(params.taskId, extra.mcpCtx.sessionId);

            const cancelledTask = await this.config.taskStore.getTask(params.taskId, extra.mcpCtx.sessionId);
            if (!cancelledTask) {
                throw new McpError(ErrorCode.InvalidParams, `Task not found after cancellation: ${params.taskId}`);
            }

            return { _meta: {}, ...cancelledTask };
        } catch (error) {
            if (error instanceof McpError) {
                throw error;
            }
            throw new McpError(
                ErrorCode.InvalidRequest,
                `Failed to cancel task: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }
}

/**
 * Factory function to create a TaskPlugin.
 */
export function createTaskPlugin(config: TaskPluginConfig): TaskPlugin {
    return new TaskPlugin(config);
}
