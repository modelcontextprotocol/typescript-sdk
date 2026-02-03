import type { CreateTaskOptions, QueuedMessage, TaskMessageQueue, TaskStore } from '../experimental/tasks/interfaces.js';
import { isTerminal } from '../experimental/tasks/interfaces.js';
import type {
    GetTaskPayloadRequest,
    GetTaskRequest,
    GetTaskResult,
    JSONRPCErrorResponse,
    JSONRPCNotification,
    JSONRPCRequest,
    JSONRPCResponse,
    JSONRPCResultResponse,
    Notification,
    Request,
    RequestId,
    Result,
    Task,
    TaskCreationParams,
    TaskStatusNotification
} from '../types/types.js';
import {
    CancelTaskResultSchema,
    CreateTaskResultSchema,
    GetTaskResultSchema,
    isJSONRPCErrorResponse,
    isJSONRPCRequest,
    isJSONRPCResultResponse,
    isTaskAugmentedRequestParams,
    ListTasksResultSchema,
    ProtocolError,
    ProtocolErrorCode,
    RELATED_TASK_META_KEY,
    TaskStatusNotificationSchema
} from '../types/types.js';
import type { AnyObjectSchema, AnySchema, SchemaOutput } from '../util/schema.js';
import type { BaseContext, NotificationOptions, RequestOptions } from './protocol.js';
import type { ResponseMessage } from './responseMessage.js';

/**
 * Options that can be given per request.
 */
// relatedTask is excluded as the SDK controls if this is sent according to if the source is a task.
export type TaskRequestOptions = Omit<RequestOptions, 'relatedTask'>;

/**
 * Request-scoped TaskStore interface.
 */
export interface RequestTaskStore {
    /**
     * Creates a new task with the given creation parameters.
     * The implementation generates a unique taskId and createdAt timestamp.
     *
     * @param taskParams - The task creation parameters from the request
     * @returns The created task object
     */
    createTask(taskParams: CreateTaskOptions): Promise<Task>;

    /**
     * Gets the current status of a task.
     *
     * @param taskId - The task identifier
     * @returns The task object
     * @throws If the task does not exist
     */
    getTask(taskId: string): Promise<Task>;

    /**
     * Stores the result of a task and sets its final status.
     *
     * @param taskId - The task identifier
     * @param status - The final status: 'completed' for success, 'failed' for errors
     * @param result - The result to store
     */
    storeTaskResult(taskId: string, status: 'completed' | 'failed', result: Result): Promise<void>;

    /**
     * Retrieves the stored result of a task.
     *
     * @param taskId - The task identifier
     * @returns The stored result
     */
    getTaskResult(taskId: string): Promise<Result>;

    /**
     * Updates a task's status (e.g., to 'cancelled', 'failed', 'completed').
     *
     * @param taskId - The task identifier
     * @param status - The new status
     * @param statusMessage - Optional diagnostic message for failed tasks or other status information
     */
    updateTaskStatus(taskId: string, status: Task['status'], statusMessage?: string): Promise<void>;

    /**
     * Lists tasks, optionally starting from a pagination cursor.
     *
     * @param cursor - Optional cursor for pagination
     * @returns An object containing the tasks array and an optional nextCursor
     */
    listTasks(cursor?: string): Promise<{ tasks: Task[]; nextCursor?: string }>;
}

/**
 * Task context provided to request handlers when task storage is configured.
 */
export type TaskContext = {
    id?: string;
    store: RequestTaskStore;
    requestedTtl?: number | null;
};

export type TaskManagerOptions = {
    /**
     * Task storage implementation. Required for handling incoming task requests (server-side).
     * Not required for sending task requests (client-side outbound API).
     */
    taskStore?: TaskStore;
    /**
     * Optional task message queue implementation for managing server-initiated messages
     * that will be delivered through the tasks/result response stream.
     */
    taskMessageQueue?: TaskMessageQueue;
    /**
     * Default polling interval (in milliseconds) for task status checks when no pollInterval
     * is provided by the server. Defaults to 1000ms if not specified.
     */
    defaultTaskPollInterval?: number;
    /**
     * Maximum number of messages that can be queued per task for side-channel delivery.
     * If undefined, the queue size is unbounded.
     */
    maxTaskQueueSize?: number;
};

export interface InboundRequestContext {
    sessionId?: string;
    sendNotification: (notification: Notification, options?: NotificationOptions) => Promise<void>;
    sendRequest: <U extends AnySchema>(request: Request, resultSchema: U, options?: RequestOptions) => Promise<SchemaOutput<U>>;
}

export interface InboundRequestResult {
    taskContext?: TaskContext;
    sendNotification: (notification: Notification) => Promise<void>;
    sendRequest: <U extends AnySchema>(request: Request, resultSchema: U, options?: TaskRequestOptions) => Promise<SchemaOutput<U>>;
    routeResponse: (message: JSONRPCResponse | JSONRPCErrorResponse) => Promise<boolean>;
    hasTaskCreationParams: boolean;
}

/** @internal */
export interface TaskManagerHost {
    request<T extends AnySchema>(request: Request, resultSchema: T, options?: RequestOptions): Promise<SchemaOutput<T>>;
    notification(notification: Notification, options?: NotificationOptions): Promise<void>;
    reportError(error: Error): void;
    removeProgressHandler(token: number): void;
    registerHandler(method: string, handler: (request: JSONRPCRequest, ctx: BaseContext) => Promise<Result>): void;
    sendOnResponseStream(message: JSONRPCNotification | JSONRPCRequest, relatedRequestId: RequestId): Promise<void>;
}

/**
 * Manages task orchestration: state, message queuing, and polling.
 */
export class TaskManager {
    private _taskStore?: TaskStore;
    private _taskMessageQueue?: TaskMessageQueue;
    private _taskProgressTokens: Map<string, number> = new Map();
    private _requestResolvers: Map<RequestId, (response: JSONRPCResultResponse | Error) => void> = new Map();
    private _options: TaskManagerOptions;
    private _host?: TaskManagerHost;

    constructor(options: TaskManagerOptions) {
        this._options = options;
        this._taskStore = options.taskStore;
        this._taskMessageQueue = options.taskMessageQueue;
    }

    bind(host: TaskManagerHost): void {
        this._host = host;

        if (this._taskStore) {
            host.registerHandler('tasks/get', async (request, ctx) => {
                const params = request.params as { taskId: string };
                const task = await this.handleGetTask(params.taskId, ctx.sessionId);
                // Per spec: tasks/get responses SHALL NOT include related-task metadata
                // as the taskId parameter is the source of truth
                return {
                    ...task
                } as Result;
            });

            host.registerHandler('tasks/result', async (request, ctx) => {
                const params = request.params as { taskId: string };
                return await this.handleGetTaskPayload(params.taskId, ctx.sessionId, ctx.mcpReq.signal, async message => {
                    // Send the message on the response stream by passing the relatedRequestId
                    // This tells the transport to write the message to the tasks/result response stream
                    await host.sendOnResponseStream(message, ctx.mcpReq.id);
                });
            });

            host.registerHandler('tasks/list', async (request, ctx) => {
                const params = request.params as { cursor?: string } | undefined;
                return (await this.handleListTasks(params?.cursor, ctx.sessionId)) as Result;
            });

            host.registerHandler('tasks/cancel', async (request, ctx) => {
                const params = request.params as { taskId: string };
                return await this.handleCancelTask(params.taskId, ctx.sessionId);
            });
        }
    }

    private get _requireHost(): TaskManagerHost {
        if (!this._host) {
            throw new ProtocolError(ProtocolErrorCode.InternalError, 'TaskManager is not bound to a Protocol host — call bind() first');
        }
        return this._host;
    }

    get taskStore(): TaskStore | undefined {
        return this._taskStore;
    }

    private get _requireTaskStore(): TaskStore {
        if (!this._taskStore) {
            throw new ProtocolError(ProtocolErrorCode.InternalError, 'TaskStore is not configured');
        }
        return this._taskStore;
    }

    get taskMessageQueue(): TaskMessageQueue | undefined {
        return this._taskMessageQueue;
    }

    // -- Public API (client-facing) --
    async *requestStream<T extends AnyObjectSchema>(
        request: Request,
        resultSchema: T,
        options?: RequestOptions
    ): AsyncGenerator<ResponseMessage<SchemaOutput<T>>, void, void> {
        const host = this._requireHost;
        const { task } = options ?? {};

        if (!task) {
            try {
                const result = await host.request(request, resultSchema, options);
                yield { type: 'result', result };
            } catch (error) {
                yield {
                    type: 'error',
                    error: error instanceof Error ? error : new Error(String(error))
                };
            }
            return;
        }

        let taskId: string | undefined;
        try {
            const createResult = await host.request(request, CreateTaskResultSchema, options);

            if (createResult.task) {
                taskId = createResult.task.taskId;
                yield { type: 'taskCreated', task: createResult.task };
            } else {
                throw new ProtocolError(ProtocolErrorCode.InternalError, 'Task creation did not return a task');
            }

            while (true) {
                const task = await this.getTask({ taskId }, options);
                yield { type: 'taskStatus', task };

                if (isTerminal(task.status)) {
                    switch (task.status) {
                        case 'completed': {
                            const result = await this.getTaskResult({ taskId }, resultSchema, options);
                            yield { type: 'result', result };
                            break;
                        }
                        case 'failed': {
                            yield { type: 'error', error: new ProtocolError(ProtocolErrorCode.InternalError, `Task ${taskId} failed`) };
                            break;
                        }
                        case 'cancelled': {
                            yield {
                                type: 'error',
                                error: new ProtocolError(ProtocolErrorCode.InternalError, `Task ${taskId} was cancelled`)
                            };
                            break;
                        }
                    }
                    return;
                }

                if (task.status === 'input_required') {
                    const result = await this.getTaskResult({ taskId }, resultSchema, options);
                    yield { type: 'result', result };
                    return;
                }

                const pollInterval = task.pollInterval ?? this._options.defaultTaskPollInterval ?? 1000;
                await new Promise(resolve => setTimeout(resolve, pollInterval));
                options?.signal?.throwIfAborted();
            }
        } catch (error) {
            yield {
                type: 'error',
                error: error instanceof Error ? error : new Error(String(error))
            };
        }
    }

    async getTask(params: GetTaskRequest['params'], options?: RequestOptions): Promise<GetTaskResult> {
        return this._requireHost.request({ method: 'tasks/get', params }, GetTaskResultSchema, options);
    }

    async getTaskResult<T extends AnySchema>(
        params: GetTaskPayloadRequest['params'],
        resultSchema: T,
        options?: RequestOptions
    ): Promise<SchemaOutput<T>> {
        return this._requireHost.request({ method: 'tasks/result', params }, resultSchema, options);
    }

    async listTasks(params?: { cursor?: string }, options?: RequestOptions): Promise<SchemaOutput<typeof ListTasksResultSchema>> {
        return this._requireHost.request({ method: 'tasks/list', params }, ListTasksResultSchema, options);
    }

    async cancelTask(params: { taskId: string }, options?: RequestOptions): Promise<SchemaOutput<typeof CancelTaskResultSchema>> {
        return this._requireHost.request({ method: 'tasks/cancel', params }, CancelTaskResultSchema, options);
    }

    // -- Handler bodies (delegated from Protocol's registered handlers) --

    private async handleGetTask(taskId: string, sessionId?: string): Promise<Task> {
        const task = await this._requireTaskStore.getTask(taskId, sessionId);
        if (!task) {
            throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Failed to retrieve task: Task not found');
        }
        return task;
    }

    private async handleGetTaskPayload(
        taskId: string,
        sessionId: string | undefined,
        signal: AbortSignal,
        sendOnResponseStream: (message: JSONRPCNotification | JSONRPCRequest) => Promise<void>
    ): Promise<Result> {
        const handleTaskResult = async (): Promise<Result> => {
            if (this._taskMessageQueue) {
                let queuedMessage: QueuedMessage | undefined;
                while ((queuedMessage = await this._taskMessageQueue.dequeue(taskId, sessionId))) {
                    if (queuedMessage.type === 'response' || queuedMessage.type === 'error') {
                        const message = queuedMessage.message;
                        const requestId = message.id;
                        const resolver = this._requestResolvers.get(requestId as RequestId);

                        if (resolver) {
                            this._requestResolvers.delete(requestId as RequestId);
                            if (queuedMessage.type === 'response') {
                                resolver(message as JSONRPCResultResponse);
                            } else {
                                const errorMessage = message as JSONRPCErrorResponse;
                                resolver(new ProtocolError(errorMessage.error.code, errorMessage.error.message, errorMessage.error.data));
                            }
                        } else {
                            const messageType = queuedMessage.type === 'response' ? 'Response' : 'Error';
                            this._host?.reportError(new Error(`${messageType} handler missing for request ${requestId}`));
                        }
                        continue;
                    }

                    await sendOnResponseStream(queuedMessage.message as JSONRPCNotification | JSONRPCRequest);
                }
            }

            const task = await this._requireTaskStore.getTask(taskId, sessionId);
            if (!task) {
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Task not found: ${taskId}`);
            }

            if (!isTerminal(task.status)) {
                await this._waitForTaskUpdate(taskId, signal);
                return await handleTaskResult();
            }

            const result = await this._requireTaskStore.getTaskResult(taskId, sessionId);
            await this._clearTaskQueue(taskId);

            return {
                ...result,
                _meta: {
                    ...result._meta,
                    [RELATED_TASK_META_KEY]: { taskId }
                }
            };
        };

        return await handleTaskResult();
    }

    private async handleListTasks(
        cursor: string | undefined,
        sessionId?: string
    ): Promise<{ tasks: Task[]; nextCursor?: string; _meta: Record<string, unknown> }> {
        try {
            const { tasks, nextCursor } = await this._requireTaskStore.listTasks(cursor, sessionId);
            return { tasks, nextCursor, _meta: {} };
        } catch (error) {
            throw new ProtocolError(
                ProtocolErrorCode.InvalidParams,
                `Failed to list tasks: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    private async handleCancelTask(taskId: string, sessionId?: string): Promise<Result> {
        try {
            const task = await this._requireTaskStore.getTask(taskId, sessionId);
            if (!task) {
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Task not found: ${taskId}`);
            }

            if (isTerminal(task.status)) {
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Cannot cancel task in terminal status: ${task.status}`);
            }

            await this._requireTaskStore.updateTaskStatus(taskId, 'cancelled', 'Client cancelled task execution.', sessionId);
            await this._clearTaskQueue(taskId);

            const cancelledTask = await this._requireTaskStore.getTask(taskId, sessionId);
            if (!cancelledTask) {
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Task not found after cancellation: ${taskId}`);
            }

            return { _meta: {}, ...cancelledTask };
        } catch (error) {
            if (error instanceof ProtocolError) throw error;
            throw new ProtocolError(
                ProtocolErrorCode.InvalidRequest,
                `Failed to cancel task: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    // -- Internal delegation methods --

    private prepareOutboundRequest(
        jsonrpcRequest: JSONRPCRequest,
        options: RequestOptions | undefined,
        messageId: number,
        responseHandler: (response: JSONRPCResultResponse | Error) => void,
        onError: (error: unknown) => void
    ): boolean {
        const { task, relatedTask } = options ?? {};

        if (task) {
            jsonrpcRequest.params = {
                ...jsonrpcRequest.params,
                task: task
            };
        }

        if (relatedTask) {
            jsonrpcRequest.params = {
                ...jsonrpcRequest.params,
                _meta: {
                    ...jsonrpcRequest.params?._meta,
                    [RELATED_TASK_META_KEY]: relatedTask
                }
            };
        }

        const relatedTaskId = relatedTask?.taskId;
        if (relatedTaskId) {
            this._requestResolvers.set(messageId, responseHandler);

            this._enqueueTaskMessage(relatedTaskId, {
                type: 'request',
                message: jsonrpcRequest,
                timestamp: Date.now()
            }).catch(error => {
                onError(error);
            });

            return true;
        }

        return false;
    }

    private extractInboundTaskContext(
        request: JSONRPCRequest,
        sessionId?: string
    ): {
        relatedTaskId?: string;
        taskCreationParams?: TaskCreationParams;
        taskContext?: TaskContext;
    } {
        const relatedTaskId = (request.params?._meta as Record<string, { taskId?: string }> | undefined)?.[RELATED_TASK_META_KEY]?.taskId;
        const taskCreationParams = isTaskAugmentedRequestParams(request.params) ? request.params.task : undefined;

        // Provide task context whenever a task store is configured,
        // not just for task-related requests — tools need ctx.task.store
        let taskContext: TaskContext | undefined;
        if (this._taskStore) {
            const store = this.createRequestTaskStore(request, sessionId);
            taskContext = {
                id: relatedTaskId,
                store,
                requestedTtl: taskCreationParams?.ttl
            };
        }

        if (!relatedTaskId && !taskCreationParams && !taskContext) {
            return {};
        }

        return {
            relatedTaskId,
            taskCreationParams,
            taskContext
        };
    }

    private wrapSendNotification(
        relatedTaskId: string,
        originalSendNotification: (notification: Notification, options?: NotificationOptions) => Promise<void>
    ): (notification: Notification) => Promise<void> {
        return async (notification: Notification) => {
            const notificationOptions: NotificationOptions = { relatedTask: { taskId: relatedTaskId } };
            await originalSendNotification(notification, notificationOptions);
        };
    }

    private wrapSendRequest(
        relatedTaskId: string,
        taskStore: RequestTaskStore | undefined,
        originalSendRequest: <V extends AnySchema>(request: Request, resultSchema: V, options?: RequestOptions) => Promise<SchemaOutput<V>>
    ): <V extends AnySchema>(request: Request, resultSchema: V, options?: TaskRequestOptions) => Promise<SchemaOutput<V>> {
        return async <V extends AnySchema>(request: Request, resultSchema: V, options?: TaskRequestOptions) => {
            const requestOptions: RequestOptions = { ...options };
            if (!requestOptions.relatedTask) {
                requestOptions.relatedTask = { taskId: relatedTaskId };
            }

            const effectiveTaskId = requestOptions.relatedTask?.taskId ?? relatedTaskId;
            if (effectiveTaskId && taskStore) {
                await taskStore.updateTaskStatus(effectiveTaskId, 'input_required');
            }

            return await originalSendRequest(request, resultSchema, requestOptions);
        };
    }

    private handleResponse(response: JSONRPCResponse | JSONRPCErrorResponse): boolean {
        const messageId = Number(response.id);
        const resolver = this._requestResolvers.get(messageId);
        if (resolver) {
            this._requestResolvers.delete(messageId);
            if (isJSONRPCResultResponse(response)) {
                resolver(response);
            } else {
                resolver(new ProtocolError(response.error.code, response.error.message, response.error.data));
            }
            return true;
        }
        return false;
    }

    private shouldPreserveProgressHandler(response: JSONRPCResponse | JSONRPCErrorResponse, messageId: number): boolean {
        if (isJSONRPCResultResponse(response) && response.result && typeof response.result === 'object') {
            const result = response.result as Record<string, unknown>;
            if (result.task && typeof result.task === 'object') {
                const task = result.task as Record<string, unknown>;
                if (typeof task.taskId === 'string') {
                    this._taskProgressTokens.set(task.taskId, messageId);
                    return true;
                }
            }
        }
        return false;
    }

    private async routeNotification(notification: Notification, options?: NotificationOptions): Promise<boolean> {
        const relatedTaskId = options?.relatedTask?.taskId;
        if (!relatedTaskId) return false;

        const jsonrpcNotification: JSONRPCNotification = {
            ...notification,
            jsonrpc: '2.0',
            params: {
                ...notification.params,
                _meta: {
                    ...notification.params?._meta,
                    [RELATED_TASK_META_KEY]: options!.relatedTask
                }
            }
        };

        await this._enqueueTaskMessage(relatedTaskId, {
            type: 'notification',
            message: jsonrpcNotification,
            timestamp: Date.now()
        });

        return true;
    }

    private async routeResponse(
        relatedTaskId: string | undefined,
        message: JSONRPCResponse | JSONRPCErrorResponse,
        sessionId?: string
    ): Promise<boolean> {
        if (!relatedTaskId || !this._taskMessageQueue) return false;

        await (isJSONRPCErrorResponse(message)
            ? this._enqueueTaskMessage(relatedTaskId, { type: 'error', message, timestamp: Date.now() }, sessionId)
            : this._enqueueTaskMessage(
                  relatedTaskId,
                  { type: 'response', message: message as JSONRPCResultResponse, timestamp: Date.now() },
                  sessionId
              ));
        return true;
    }

    private createRequestTaskStore(request?: JSONRPCRequest, sessionId?: string): RequestTaskStore {
        const taskStore = this._requireTaskStore;
        const host = this._host;

        return {
            createTask: async taskParams => {
                if (!request) throw new Error('No request provided');
                return await taskStore.createTask(taskParams, request.id, { method: request.method, params: request.params }, sessionId);
            },
            getTask: async taskId => {
                const task = await taskStore.getTask(taskId, sessionId);
                if (!task) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Failed to retrieve task: Task not found');
                return task;
            },
            storeTaskResult: async (taskId, status, result) => {
                await taskStore.storeTaskResult(taskId, status, result, sessionId);
                const task = await taskStore.getTask(taskId, sessionId);
                if (task) {
                    const notification: TaskStatusNotification = TaskStatusNotificationSchema.parse({
                        method: 'notifications/tasks/status',
                        params: task
                    });
                    await host?.notification(notification as Notification);
                    if (isTerminal(task.status)) {
                        this._cleanupTaskProgressHandler(taskId);
                    }
                }
            },
            getTaskResult: taskId => taskStore.getTaskResult(taskId, sessionId),
            updateTaskStatus: async (taskId, status, statusMessage) => {
                const task = await taskStore.getTask(taskId, sessionId);
                if (!task) {
                    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Task "${taskId}" not found - it may have been cleaned up`);
                }
                if (isTerminal(task.status)) {
                    throw new ProtocolError(
                        ProtocolErrorCode.InvalidParams,
                        `Cannot update task "${taskId}" from terminal status "${task.status}" to "${status}". Terminal states (completed, failed, cancelled) cannot transition to other states.`
                    );
                }
                await taskStore.updateTaskStatus(taskId, status, statusMessage, sessionId);
                const updatedTask = await taskStore.getTask(taskId, sessionId);
                if (updatedTask) {
                    const notification: TaskStatusNotification = TaskStatusNotificationSchema.parse({
                        method: 'notifications/tasks/status',
                        params: updatedTask
                    });
                    await host?.notification(notification as Notification);
                    if (isTerminal(updatedTask.status)) {
                        this._cleanupTaskProgressHandler(taskId);
                    }
                }
            },
            listTasks: cursor => taskStore.listTasks(cursor, sessionId)
        };
    }

    // -- Consolidated lifecycle methods (called by Protocol) --

    processInboundRequest(request: JSONRPCRequest, ctx: InboundRequestContext): InboundRequestResult {
        const taskInfo = this.extractInboundTaskContext(request, ctx.sessionId);
        const relatedTaskId = taskInfo?.relatedTaskId;

        const sendNotification = relatedTaskId
            ? this.wrapSendNotification(relatedTaskId, ctx.sendNotification)
            : (notification: Notification) => ctx.sendNotification(notification);

        const sendRequest = taskInfo?.taskContext
            ? this.wrapSendRequest(relatedTaskId ?? '', taskInfo.taskContext.store, ctx.sendRequest)
            : ctx.sendRequest;

        return {
            taskContext: taskInfo?.taskContext,
            sendNotification,
            sendRequest,
            routeResponse: async (message: JSONRPCResponse | JSONRPCErrorResponse) => {
                if (relatedTaskId) {
                    return this.routeResponse(relatedTaskId, message, ctx.sessionId);
                }
                return false;
            },
            hasTaskCreationParams: !!taskInfo?.taskCreationParams
        };
    }

    processOutboundRequest(
        jsonrpcRequest: JSONRPCRequest,
        options: RequestOptions | undefined,
        messageId: number,
        responseHandler: (response: JSONRPCResultResponse | Error) => void,
        onError: (error: unknown) => void
    ): { queued: boolean } {
        const queued = this.prepareOutboundRequest(jsonrpcRequest, options, messageId, responseHandler, onError);
        return { queued };
    }

    processInboundResponse(
        response: JSONRPCResponse | JSONRPCErrorResponse,
        messageId: number
    ): { consumed: boolean; preserveProgress: boolean } {
        const consumed = this.handleResponse(response);
        if (consumed) {
            return { consumed: true, preserveProgress: false };
        }
        const preserveProgress = this.shouldPreserveProgressHandler(response, messageId);
        return { consumed: false, preserveProgress };
    }

    async processOutboundNotification(
        notification: Notification,
        options?: NotificationOptions
    ): Promise<{ queued: boolean; jsonrpcNotification?: JSONRPCNotification }> {
        // Try queuing first
        const queued = await this.routeNotification(notification, options);
        if (queued) return { queued: true };

        // Build JSONRPC notification with optional relatedTask metadata
        let jsonrpcNotification: JSONRPCNotification = { ...notification, jsonrpc: '2.0' };
        if (options?.relatedTask) {
            jsonrpcNotification = {
                ...jsonrpcNotification,
                params: {
                    ...jsonrpcNotification.params,
                    _meta: {
                        ...jsonrpcNotification.params?._meta,
                        [RELATED_TASK_META_KEY]: options.relatedTask
                    }
                }
            };
        }
        return { queued: false, jsonrpcNotification };
    }

    onClose(): void {
        this._taskProgressTokens.clear();
    }

    // -- Private helpers --

    private async _enqueueTaskMessage(taskId: string, message: QueuedMessage, sessionId?: string): Promise<void> {
        if (!this._taskStore || !this._taskMessageQueue) {
            throw new Error('Cannot enqueue task message: taskStore and taskMessageQueue are not configured');
        }
        await this._taskMessageQueue.enqueue(taskId, message, sessionId, this._options.maxTaskQueueSize);
    }

    private async _clearTaskQueue(taskId: string, sessionId?: string): Promise<void> {
        if (this._taskMessageQueue) {
            const messages = await this._taskMessageQueue.dequeueAll(taskId, sessionId);
            for (const message of messages) {
                if (message.type === 'request' && isJSONRPCRequest(message.message)) {
                    const requestId = message.message.id as RequestId;
                    const resolver = this._requestResolvers.get(requestId);
                    if (resolver) {
                        resolver(new ProtocolError(ProtocolErrorCode.InternalError, 'Task cancelled or completed'));
                        this._requestResolvers.delete(requestId);
                    } else {
                        this._host?.reportError(new Error(`Resolver missing for request ${requestId} during task ${taskId} cleanup`));
                    }
                }
            }
        }
    }

    private async _waitForTaskUpdate(taskId: string, signal: AbortSignal): Promise<void> {
        let interval = this._options.defaultTaskPollInterval ?? 1000;
        try {
            const task = await this._requireTaskStore.getTask(taskId);
            if (task?.pollInterval) interval = task.pollInterval;
        } catch {
            // Use default interval
        }

        return new Promise((resolve, reject) => {
            if (signal.aborted) {
                reject(new ProtocolError(ProtocolErrorCode.InvalidRequest, 'Request cancelled'));
                return;
            }
            const timeoutId = setTimeout(resolve, interval);
            signal.addEventListener(
                'abort',
                () => {
                    clearTimeout(timeoutId);
                    reject(new ProtocolError(ProtocolErrorCode.InvalidRequest, 'Request cancelled'));
                },
                { once: true }
            );
        });
    }

    private _cleanupTaskProgressHandler(taskId: string): void {
        const progressToken = this._taskProgressTokens.get(taskId);
        if (progressToken !== undefined) {
            this._host?.removeProgressHandler(progressToken);
            this._taskProgressTokens.delete(taskId);
        }
    }
}

/**
 * No-op TaskManager used when task support is not configured.
 */
export class NullTaskManager extends TaskManager {
    constructor() {
        super({});
    }

    override processInboundRequest(_request: JSONRPCRequest, ctx: InboundRequestContext): InboundRequestResult {
        return {
            taskContext: undefined,
            sendNotification: (notification: Notification) => ctx.sendNotification(notification),
            sendRequest: ctx.sendRequest,
            routeResponse: async () => false,
            hasTaskCreationParams: false
        };
    }

    // processOutboundRequest is inherited - it handles task/relatedTask augmentation
    // and only queues if relatedTask is set (which won't happen without a task store)

    // processInboundResponse is inherited - it checks _requestResolvers (empty for NullTaskManager)
    // and _taskProgressTokens (empty for NullTaskManager)

    override async processOutboundNotification(
        notification: Notification,
        _options?: NotificationOptions
    ): Promise<{ queued: boolean; jsonrpcNotification?: JSONRPCNotification }> {
        return { queued: false, jsonrpcNotification: { ...notification, jsonrpc: '2.0' } };
    }

    override onClose(): void {
        // No-op
    }
}
