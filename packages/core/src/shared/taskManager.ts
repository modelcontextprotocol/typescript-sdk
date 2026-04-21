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
} from '../types/index.js';
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
} from '../types/index.js';
import type { AnyObjectSchema, AnySchema, SchemaOutput } from '../util/schema.js';
import type { NotificationOptions, Outbound, RequestEnv, RequestOptions } from './context.js';
import type { Dispatcher, DispatchFn, DispatchMiddleware, DispatchOutput } from './dispatcher.js';
import type { ResponseMessage } from './responseMessage.js';

/**
 * Hooks {@linkcode TaskManager.attachTo} needs from its owner. The owner is whoever
 * holds the {@linkcode Outbound} (McpServer/Client/Protocol). Replaces the
 * previous wider host vtable: most of what the vtable provided is reachable via
 * `channel()` or via the {@linkcode Dispatcher} passed to `attachTo`.
 * @internal
 */
export interface TaskAttachHooks {
    /** Current outbound channel (may be undefined before connect). */
    channel(): Outbound | undefined;
    /** Surface non-fatal errors. */
    reportError(error: Error): void;
    enforceStrictCapabilities: boolean;
    assertTaskCapability(method: string): void;
    assertTaskHandlerCapability(method: string): void;
}

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
    requestedTtl?: number;
    /**
     * Yield a queued task message on the *current* dispatch's response stream.
     * Set by the dispatch middleware; used by the `tasks/result` handler so queued
     * messages flow on the same stream as that handler's terminal response.
     * @internal
     */
    sendOnResponseStream?: (message: JSONRPCNotification | JSONRPCRequest) => void;
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

/**
 * Extracts {@linkcode TaskManagerOptions} from a capability object that mixes in runtime fields.
 * Returns `undefined` when no task capability is configured.
 */
export function extractTaskManagerOptions(tasksCapability: TaskManagerOptions | undefined): TaskManagerOptions | undefined {
    if (!tasksCapability) return undefined;
    const { taskStore, taskMessageQueue, defaultTaskPollInterval, maxTaskQueueSize } = tasksCapability;
    return { taskStore, taskMessageQueue, defaultTaskPollInterval, maxTaskQueueSize };
}

/**
 * Manages task orchestration: state, message queuing, and polling.
 * Capability checking is delegated to the Protocol host.
 * @internal
 */
export class TaskManager {
    private _taskStore?: TaskStore;
    private _taskMessageQueue?: TaskMessageQueue;
    /** @internal id allocator for dispatch-middleware-queued requests (independent of any transport's id space). */
    _dispatchOutboundId = 0;
    private _taskProgressTokens: Map<string, number> = new Map();
    private _requestResolvers: Map<RequestId, (response: JSONRPCResultResponse | Error) => void> = new Map();
    private _options: TaskManagerOptions;
    private _hooks?: TaskAttachHooks;

    constructor(options: TaskManagerOptions) {
        this._options = options;
        this._taskStore = options.taskStore;
        this._taskMessageQueue = options.taskMessageQueue;
    }

    /**
     * Attaches this manager to a {@linkcode Dispatcher}: registers the dispatch middleware
     * via `d.use()`, installs `tasks/*` request handlers when a store is configured, and
     * stores the {@linkcode TaskAttachHooks}. Outbound-side hooks (request/notification
     * augmentation, response correlation, close) are called directly by the channel adapter
     * (see {@linkcode StreamDriver}), which receives this manager via {@linkcode AttachOptions}.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- attach is context-agnostic
    attachTo(d: Dispatcher<any>, hooks: TaskAttachHooks): void {
        this._hooks = hooks;
        d.use(this.dispatchMiddleware);

        if (this._taskStore) {
            d.setRawRequestHandler('tasks/get', async (request, ctx) => {
                const params = request.params as { taskId: string };
                return (await this.handleGetTask(params.taskId, ctx.sessionId)) as Result;
            });

            d.setRawRequestHandler('tasks/result', async (request, ctx) => {
                const params = request.params as { taskId: string };
                return this.handleGetTaskPayload(params.taskId, ctx.sessionId, ctx.mcpReq.signal, async message => {
                    const sink =
                        ctx.task?.sendOnResponseStream ??
                        ((m: JSONRPCNotification | JSONRPCRequest) => {
                            void hooks.channel()?.sendRaw?.(m, { relatedRequestId: ctx.mcpReq.id });
                        });
                    sink(message);
                });
            });

            d.setRawRequestHandler('tasks/list', async (request, ctx) => {
                const params = request.params as { cursor?: string } | undefined;
                return (await this.handleListTasks(params?.cursor, ctx.sessionId)) as Result;
            });

            d.setRawRequestHandler('tasks/cancel', async (request, ctx) => {
                const params = request.params as { taskId: string };
                return this.handleCancelTask(params.taskId, ctx.sessionId);
            });
        }
    }

    protected get _requireHooks(): TaskAttachHooks {
        if (!this._hooks) {
            throw new ProtocolError(ProtocolErrorCode.InternalError, 'TaskManager is not attached to a Dispatcher — call attachTo() first');
        }
        return this._hooks;
    }

    /**
     * The {@linkcode DispatchMiddleware}: detects task-augmented inbound requests, builds
     * `env.task` (with the request-scoped store + side-channel sink), wraps `env.send` to
     * carry `relatedTask`, intercepts yielded notifications/response for queueing.
     */
    get dispatchMiddleware(): DispatchMiddleware {
        // eslint-disable-next-line @typescript-eslint/no-this-alias, unicorn/no-this-assignment
        const tm = this;
        return next =>
            async function* (request, env = {}) {
                const taskInfo = tm.extractInboundTaskContext(request, env.sessionId);
                const relatedTaskId = taskInfo?.relatedTaskId;
                const hasTaskCreationParams = !!taskInfo?.taskCreationParams;

                if (hasTaskCreationParams) {
                    try {
                        tm._requireHooks.assertTaskHandlerCapability(request.method);
                    } catch (error) {
                        const e = error as { code?: number; message?: string; data?: unknown };
                        yield {
                            kind: 'response',
                            message: {
                                jsonrpc: '2.0',
                                id: request.id,
                                error: {
                                    code: Number.isSafeInteger(e?.code) ? (e.code as number) : ProtocolErrorCode.InternalError,
                                    message: e?.message ?? 'Internal error',
                                    ...(e?.data !== undefined && { data: e.data })
                                }
                            }
                        };
                        return;
                    }
                }

                // Side-channel sink so `tasks/result` (and any handler) can yield arbitrary
                // queued messages on this dispatch's stream. Drained interleaved with `next()`.
                const sideQueue: (JSONRPCNotification | JSONRPCRequest)[] = [];
                let wake: (() => void) | undefined;
                const sendOnResponseStream = (m: JSONRPCNotification | JSONRPCRequest) => {
                    sideQueue.push(m);
                    wake?.();
                };
                const drain = function* (): Generator<DispatchOutput> {
                    while (sideQueue.length > 0) {
                        const m = sideQueue.shift()!;
                        yield { kind: 'notification', message: m as JSONRPCNotification };
                    }
                };

                const wrappedSend: NonNullable<RequestEnv['send']> = async (r, opts) => {
                    const relatedTask = relatedTaskId && !opts?.relatedTask ? { taskId: relatedTaskId } : opts?.relatedTask;
                    const effectiveTaskId = relatedTask?.taskId;
                    if (effectiveTaskId && taskInfo?.taskContext?.store) {
                        await taskInfo.taskContext.store.updateTaskStatus(effectiveTaskId, 'input_required');
                    }
                    if (effectiveTaskId) {
                        // Queue to the task message queue (delivered via tasks/result), don't hit env.send.
                        return new Promise<Result>((resolve, reject) => {
                            const messageId = tm._dispatchOutboundId++;
                            const wire: JSONRPCRequest = { jsonrpc: '2.0', id: messageId, method: r.method, params: r.params };
                            const settle = (resp: { result: Result } | Error) =>
                                resp instanceof Error ? reject(resp) : resolve(resp.result);
                            const { queued } = tm.processOutboundRequest(wire, { ...opts, relatedTask }, messageId, settle, reject);
                            if (queued) return;
                            if (env.send) {
                                env.send(r, { ...opts, relatedTask }).then(result => settle({ result }), reject);
                            } else {
                                reject(new ProtocolError(ProtocolErrorCode.InternalError, 'env.send unavailable'));
                            }
                        });
                    }
                    if (env.send) return env.send(r, { ...opts, relatedTask });
                    throw new ProtocolError(ProtocolErrorCode.InternalError, 'env.send unavailable');
                };

                const taskCtx: TaskContext | undefined = taskInfo?.taskContext
                    ? { ...taskInfo.taskContext, sendOnResponseStream }
                    : tm._taskStore
                      ? { store: tm.createRequestTaskStore(request, env.sessionId), sendOnResponseStream }
                      : undefined;

                const taskEnv: RequestEnv = {
                    ...env,
                    task: taskCtx ?? env.task,
                    send: relatedTaskId || taskInfo?.taskContext ? wrappedSend : env.send
                };

                const inner = next(request, taskEnv);
                let pending: Promise<IteratorResult<DispatchOutput>> | undefined;
                while (true) {
                    yield* drain();
                    pending ??= inner.next();
                    const wakeP = new Promise<'side'>(resolve => {
                        wake = () => resolve('side');
                    });
                    if (sideQueue.length > 0) {
                        wake = undefined;
                        continue;
                    }
                    const r = await Promise.race([pending, wakeP]);
                    wake = undefined;
                    if (r === 'side') continue;
                    pending = undefined;
                    if (r.done) break;
                    const out = r.value;
                    if (out.kind === 'response') {
                        const routed = relatedTaskId ? await tm.routeResponse(relatedTaskId, out.message, env.sessionId) : false;
                        if (!routed) {
                            yield* drain();
                            yield out;
                        }
                    } else if (relatedTaskId === undefined) {
                        yield out;
                    } else {
                        // Handler-emitted notifications inside a related-task request are queued
                        // (not yielded) so they deliver via tasks/result, avoiding duplicate
                        // delivery on bidirectional transports.
                        const result = await tm.processOutboundNotification(
                            { method: out.message.method, params: out.message.params },
                            { relatedTask: { taskId: relatedTaskId } }
                        );
                        if (!result.queued && result.jsonrpcNotification) {
                            yield { kind: 'notification', message: result.jsonrpcNotification };
                        }
                    }
                }
                yield* drain();
            } as DispatchFn;
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

    private _outboundRequest<T extends AnySchema>(req: Request, schema: T, opts?: RequestOptions): Promise<SchemaOutput<T>> {
        const ch = this._requireHooks.channel();
        if (!ch) throw new ProtocolError(ProtocolErrorCode.InternalError, 'Not connected');
        return this.sendRequest(req, schema, opts, ch);
    }

    // -- Public API (client-facing) --
    async *requestStream<T extends AnyObjectSchema>(
        request: Request,
        resultSchema: T,
        options?: RequestOptions
    ): AsyncGenerator<ResponseMessage<SchemaOutput<T>>, void, void> {
        const { task } = options ?? {};

        if (!task) {
            try {
                const result = await this._outboundRequest(request, resultSchema, options);
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
            const createResult = await this._outboundRequest(request, CreateTaskResultSchema, options);

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
        return this._outboundRequest({ method: 'tasks/get', params }, GetTaskResultSchema, options);
    }

    async getTaskResult<T extends AnySchema>(
        params: GetTaskPayloadRequest['params'],
        resultSchema: T,
        options?: RequestOptions
    ): Promise<SchemaOutput<T>> {
        return this._outboundRequest({ method: 'tasks/result', params }, resultSchema, options);
    }

    async listTasks(params?: { cursor?: string }, options?: RequestOptions): Promise<SchemaOutput<typeof ListTasksResultSchema>> {
        return this._outboundRequest({ method: 'tasks/list', params }, ListTasksResultSchema, options);
    }

    async cancelTask(params: { taskId: string }, options?: RequestOptions): Promise<SchemaOutput<typeof CancelTaskResultSchema>> {
        return this._outboundRequest({ method: 'tasks/cancel', params }, CancelTaskResultSchema, options);
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
                            this._hooks?.reportError(new Error(`${messageType} handler missing for request ${requestId}`));
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
                await this._waitForTaskUpdate(task.pollInterval, signal);
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
        const hooks = this._hooks;

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
                    await hooks?.channel()?.notification(notification as Notification);
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
                    await hooks?.channel()?.notification(notification as Notification);
                    if (isTerminal(updatedTask.status)) {
                        this._cleanupTaskProgressHandler(taskId);
                    }
                }
            },
            listTasks: cursor => taskStore.listTasks(cursor, sessionId)
        };
    }

    // -- Outbound helpers (called by McpServer/Client/Protocol before delegating to Outbound) --

    /**
     * Task-aware request send: routes through {@linkcode RequestOptions.intercept} so the
     * channel adapter builds the wire (id/progressToken/handlers) and TaskManager decides
     * whether to queue it. Use this where instance-level outbound requests are made
     * (Protocol/McpServer/Client), so the channel adapter stays task-agnostic.
     */
    sendRequest<T extends AnySchema>(
        request: Request,
        resultSchema: T,
        options: RequestOptions | undefined,
        outbound: Outbound
    ): Promise<SchemaOutput<T>> {
        if (!options?.relatedTask && !options?.task) {
            return outbound.request(request, resultSchema, options);
        }
        return outbound.request(request, resultSchema, {
            ...options,
            intercept: (wire, messageId, settle, onError) => this.processOutboundRequest(wire, options, messageId, settle, onError).queued
        });
    }

    /**
     * Task-aware notification send: queues when `options.relatedTask` is set, otherwise
     * delegates to `outbound.notification()` with related-task metadata attached.
     */
    async sendNotification(notification: Notification, options: NotificationOptions | undefined, outbound: Outbound): Promise<void> {
        const result = await this.processOutboundNotification(notification, options);
        if (result.queued) return;
        await outbound.notification(
            result.jsonrpcNotification
                ? { method: result.jsonrpcNotification.method, params: result.jsonrpcNotification.params }
                : notification,
            options
        );
    }

    processOutboundRequest(
        jsonrpcRequest: JSONRPCRequest,
        options: RequestOptions | undefined,
        messageId: number,
        responseHandler: (response: JSONRPCResultResponse | Error) => void,
        onError: (error: unknown) => void
    ): { queued: boolean } {
        if (this._requireHooks.enforceStrictCapabilities && options?.task) {
            this._requireHooks.assertTaskCapability(jsonrpcRequest.method);
        }

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
        this._requestResolvers.clear();
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
                        this._hooks?.reportError(new Error(`Resolver missing for request ${requestId} during task ${taskId} cleanup`));
                    }
                }
            }
        }
    }

    private async _waitForTaskUpdate(pollInterval: number | undefined, signal: AbortSignal): Promise<void> {
        const interval = pollInterval ?? this._options.defaultTaskPollInterval ?? 1000;

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
            this._hooks?.channel()?.removeProgressHandler?.(progressToken);
            this._taskProgressTokens.delete(taskId);
        }
    }
}

/**
 * No-op TaskManager used when tasks capability is not configured.
 * Its middleware getters return identity / no-op so registering it costs nothing.
 */
export class NullTaskManager extends TaskManager {
    constructor() {
        super({});
    }

    override get dispatchMiddleware(): DispatchMiddleware {
        // No store → identity middleware. Only validate task-creation capability so the
        // "client sent params.task but server has no tasks capability" error path matches.
        // eslint-disable-next-line @typescript-eslint/no-this-alias, unicorn/no-this-assignment
        const tm = this;
        return next =>
            async function* (req, env) {
                if (isTaskAugmentedRequestParams(req.params) && req.params.task) {
                    try {
                        tm._requireHooks.assertTaskHandlerCapability(req.method);
                    } catch (error) {
                        const e = error as { code?: number; message?: string; data?: unknown };
                        yield {
                            kind: 'response',
                            message: {
                                jsonrpc: '2.0',
                                id: req.id,
                                error: {
                                    code: Number.isSafeInteger(e?.code) ? (e.code as number) : ProtocolErrorCode.InternalError,
                                    message: e?.message ?? 'Internal error',
                                    ...(e?.data !== undefined && { data: e.data })
                                }
                            }
                        };
                        return;
                    }
                }
                yield* next(req, env);
            } as DispatchFn;
    }

    override async processOutboundNotification(
        notification: Notification,
        _options?: NotificationOptions
    ): Promise<{ queued: boolean; jsonrpcNotification?: JSONRPCNotification }> {
        return { queued: false, jsonrpcNotification: { ...notification, jsonrpc: '2.0' } };
    }
}
