import { ZodLiteral, ZodObject, ZodType, z } from 'zod';
import {
    CancelledNotificationSchema,
    ClientCapabilities,
    CreateTaskResultSchema,
    ErrorCode,
    GetTaskRequest,
    GetTaskRequestSchema,
    GetTaskResultSchema,
    GetTaskPayloadRequest,
    GetTaskPayloadRequestSchema,
    ListTasksRequestSchema,
    ListTasksResultSchema,
    CancelTaskRequestSchema,
    CancelTaskResultSchema,
    isJSONRPCError,
    isJSONRPCRequest,
    isJSONRPCResponse,
    isJSONRPCNotification,
    JSONRPCError,
    JSONRPCNotification,
    JSONRPCRequest,
    JSONRPCResponse,
    McpError,
    Notification,
    PingRequestSchema,
    Progress,
    ProgressNotification,
    ProgressNotificationSchema,
    RELATED_TASK_META_KEY,
    Request,
    RequestId,
    Result,
    ServerCapabilities,
    RequestMeta,
    MessageExtraInfo,
    RequestInfo,
    GetTaskResult,
    TaskCreationParams,
    RelatedTaskMetadata,
    CancelledNotification,
    Task,
    TaskStatusNotification,
    TaskStatusNotificationSchema
} from '../types.js';
import { Transport, TransportSendOptions } from './transport.js';
import { AuthInfo } from '../server/auth/types.js';
import { isTerminal, TaskStore } from './task.js';
import { ResponseMessage } from './responseMessage.js';

/**
 * Represents a message queued for side-channel delivery via tasks/result.
 */
export interface QueuedMessage {
    /** Type of message */
    type: 'request' | 'notification';
    /** The actual JSONRPC message */
    message: JSONRPCRequest | JSONRPCNotification;
    /** When it was queued */
    timestamp: number;
    /** For requests: resolver to call when response is received */
    responseResolver?: (response: JSONRPCResponse | Error) => void;
    /** For requests: the original request ID for response routing */
    originalRequestId?: RequestId;
}

/**
 * A per-task FIFO queue for server-initiated messages that will be delivered
 * through the tasks/result response stream.
 */
export class TaskMessageQueue {
    private messages: QueuedMessage[] = [];

    /**
     * Adds a message to the end of the queue.
     * @param message The message to enqueue
     */
    enqueue(message: QueuedMessage): void {
        this.messages.push(message);
    }

    /**
     * Removes and returns the first message from the queue.
     * @returns The first message, or undefined if the queue is empty
     */
    dequeue(): QueuedMessage | undefined {
        return this.messages.shift();
    }

    /**
     * Removes and returns all messages from the queue.
     * @returns Array of all messages that were in the queue
     */
    dequeueAll(): QueuedMessage[] {
        const allMessages = this.messages;
        this.messages = [];
        return allMessages;
    }

    /**
     * Removes all messages from the queue.
     */
    clear(): void {
        this.messages = [];
    }

    /**
     * Returns the number of messages in the queue.
     */
    size(): number {
        return this.messages.length;
    }

    /**
     * Checks if the queue is empty.
     */
    isEmpty(): boolean {
        return this.messages.length === 0;
    }
}

/**
 * Callback for progress notifications.
 */
export type ProgressCallback = (progress: Progress) => void;

/**
 * Additional initialization options.
 */
export type ProtocolOptions = {
    /**
     * Whether to restrict emitted requests to only those that the remote side has indicated that they can handle, through their advertised capabilities.
     *
     * Note that this DOES NOT affect checking of _local_ side capabilities, as it is considered a logic error to mis-specify those.
     *
     * Currently this defaults to false, for backwards compatibility with SDK versions that did not advertise capabilities correctly. In future, this will default to true.
     */
    enforceStrictCapabilities?: boolean;
    /**
     * An array of notification method names that should be automatically debounced.
     * Any notifications with a method in this list will be coalesced if they
     * occur in the same tick of the event loop.
     * e.g., ['notifications/tools/list_changed']
     */
    debouncedNotificationMethods?: string[];
    /**
     * Optional task storage implementation. If provided, enables task-related request handlers
     * and provides task storage capabilities to request handlers.
     */
    taskStore?: TaskStore;
    /**
     * Default polling interval (in milliseconds) for task status checks when no pollInterval
     * is provided by the server. Defaults to 5000ms if not specified.
     */
    defaultTaskPollInterval?: number;
    /**
     * Maximum number of messages that can be queued per task for side-channel delivery.
     * If undefined, the queue size is unbounded.
     * When the limit is exceeded, the task will be transitioned to failed status.
     */
    maxTaskQueueSize?: number;
};

/**
 * The default request timeout, in miliseconds.
 */
export const DEFAULT_REQUEST_TIMEOUT_MSEC = 60000;

/**
 * Options that can be given per request.
 */
export type RequestOptions = {
    /**
     * If set, requests progress notifications from the remote end (if supported). When progress notifications are received, this callback will be invoked.
     *
     * For task-augmented requests: progress notifications continue after CreateTaskResult is returned and stop automatically when the task reaches a terminal status.
     */
    onprogress?: ProgressCallback;

    /**
     * Can be used to cancel an in-flight request. This will cause an AbortError to be raised from request().
     */
    signal?: AbortSignal;

    /**
     * A timeout (in milliseconds) for this request. If exceeded, an McpError with code `RequestTimeout` will be raised from request().
     *
     * If not specified, `DEFAULT_REQUEST_TIMEOUT_MSEC` will be used as the timeout.
     */
    timeout?: number;

    /**
     * If true, receiving a progress notification will reset the request timeout.
     * This is useful for long-running operations that send periodic progress updates.
     * Default: false
     */
    resetTimeoutOnProgress?: boolean;

    /**
     * Maximum total time (in milliseconds) to wait for a response.
     * If exceeded, an McpError with code `RequestTimeout` will be raised, regardless of progress notifications.
     * If not specified, there is no maximum total timeout.
     */
    maxTotalTimeout?: number;

    /**
     * If provided, augments the request with task creation parameters to enable call-now, fetch-later execution patterns.
     */
    task?: TaskCreationParams;

    /**
     * If provided, associates this request with a related task.
     */
    relatedTask?: RelatedTaskMetadata;
} & TransportSendOptions;

/**
 * Options that can be given per notification.
 */
export type NotificationOptions = {
    /**
     * May be used to indicate to the transport which incoming request to associate this outgoing notification with.
     */
    relatedRequestId?: RequestId;

    /**
     * If provided, associates this notification with a related task.
     */
    relatedTask?: RelatedTaskMetadata;
};

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
     * @param taskParams - The task creation parameters from the request (ttl, pollInterval)
     * @param requestId - The JSON-RPC request ID
     * @param request - The original request that triggered task creation
     * @returns The task state including generated taskId, createdAt timestamp, status, ttl, pollInterval, and optional statusMessage
     */
    createTask(taskParams: TaskCreationParams, requestId: RequestId, request: Request): Promise<Task>;

    /**
     * Gets the current status of a task.
     *
     * @param taskId - The task identifier
     * @returns The task state including status, ttl, pollInterval, and optional statusMessage
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
 * Extra data given to request handlers.
 */
export type RequestHandlerExtra<SendRequestT extends Request, SendNotificationT extends Notification> = {
    /**
     * An abort signal used to communicate if the request was cancelled from the sender's side.
     */
    signal: AbortSignal;

    /**
     * Information about a validated access token, provided to request handlers.
     */
    authInfo?: AuthInfo;

    /**
     * The session ID from the transport, if available.
     */
    sessionId?: string;

    /**
     * Metadata from the original request.
     */
    _meta?: RequestMeta;

    /**
     * The JSON-RPC ID of the request being handled.
     * This can be useful for tracking or logging purposes.
     */
    requestId: RequestId;

    taskId?: string;

    taskStore?: RequestTaskStore;

    taskRequestedTtl?: number | null;

    /**
     * The original HTTP request.
     */
    requestInfo?: RequestInfo;

    /**
     * Sends a notification that relates to the current request being handled.
     *
     * This is used by certain transports to correctly associate related messages.
     */
    sendNotification: (notification: SendNotificationT) => Promise<void>;

    /**
     * Sends a request that relates to the current request being handled.
     *
     * This is used by certain transports to correctly associate related messages.
     */
    sendRequest: <U extends ZodType<Result>>(request: SendRequestT, resultSchema: U, options?: TaskRequestOptions) => Promise<z.infer<U>>;
};

/**
 * Information about a request's timeout state
 */
type TimeoutInfo = {
    timeoutId: ReturnType<typeof setTimeout>;
    startTime: number;
    timeout: number;
    maxTotalTimeout?: number;
    resetTimeoutOnProgress: boolean;
    onTimeout: () => void;
};

/**
 * Implements MCP protocol framing on top of a pluggable transport, including
 * features like request/response linking, notifications, and progress.
 */
export abstract class Protocol<SendRequestT extends Request, SendNotificationT extends Notification, SendResultT extends Result> {
    private _transport?: Transport;
    private _requestMessageId = 0;
    private _requestHandlers: Map<
        string,
        (request: JSONRPCRequest, extra: RequestHandlerExtra<SendRequestT, SendNotificationT>) => Promise<SendResultT>
    > = new Map();
    private _requestHandlerAbortControllers: Map<RequestId, AbortController> = new Map();
    private _notificationHandlers: Map<string, (notification: JSONRPCNotification) => Promise<void>> = new Map();
    private _responseHandlers: Map<number, (response: JSONRPCResponse | Error) => void> = new Map();
    private _progressHandlers: Map<number, ProgressCallback> = new Map();
    private _timeoutInfo: Map<number, TimeoutInfo> = new Map();
    private _pendingDebouncedNotifications = new Set<string>();

    // Maps task IDs to progress tokens to keep handlers alive after CreateTaskResult
    private _taskProgressTokens: Map<string, number> = new Map();

    private _taskStore?: TaskStore;

    // Task message queues for side-channel delivery
    private _taskMessageQueues: Map<string, TaskMessageQueue> = new Map();
    private _taskResultWaiters: Map<string, Array<() => void>> = new Map();
    private _requestResolvers: Map<RequestId, (response: JSONRPCResponse | Error) => void> = new Map();

    /**
     * Callback for when the connection is closed for any reason.
     *
     * This is invoked when close() is called as well.
     */
    onclose?: () => void;

    /**
     * Callback for when an error occurs.
     *
     * Note that errors are not necessarily fatal; they are used for reporting any kind of exceptional condition out of band.
     */
    onerror?: (error: Error) => void;

    /**
     * A handler to invoke for any request types that do not have their own handler installed.
     */
    fallbackRequestHandler?: (request: JSONRPCRequest, extra: RequestHandlerExtra<SendRequestT, SendNotificationT>) => Promise<SendResultT>;

    /**
     * A handler to invoke for any notification types that do not have their own handler installed.
     */
    fallbackNotificationHandler?: (notification: Notification) => Promise<void>;

    constructor(private _options?: ProtocolOptions) {
        this.setNotificationHandler(CancelledNotificationSchema, notification => {
            this._oncancel(notification);
        });

        this.setNotificationHandler(ProgressNotificationSchema, notification => {
            this._onprogress(notification as unknown as ProgressNotification);
        });

        this.setRequestHandler(
            PingRequestSchema,
            // Automatic pong by default.
            _request => ({}) as SendResultT
        );

        // Install task handlers if TaskStore is provided
        this._taskStore = _options?.taskStore;
        if (this._taskStore) {
            this.setRequestHandler(GetTaskRequestSchema, async (request, extra) => {
                const task = await this._taskStore!.getTask(request.params.taskId, extra.sessionId);
                if (!task) {
                    throw new McpError(ErrorCode.InvalidParams, 'Failed to retrieve task: Task not found');
                }

                // Per spec: tasks/get responses SHALL NOT include related-task metadata
                // as the taskId parameter is the source of truth
                // @ts-expect-error SendResultT cannot contain GetTaskResult, but we include it in our derived types everywhere else
                return {
                    ...task
                } as SendResultT;
            });

            this.setRequestHandler(GetTaskPayloadRequestSchema, async (request, extra) => {
                const handleTaskResult = async (): Promise<SendResultT> => {
                    const taskId = request.params.taskId;
                    const queue = this._taskMessageQueues.get(taskId);

                    // Deliver queued messages
                    if (queue && !queue.isEmpty()) {
                        while (!queue.isEmpty()) {
                            const queuedMessage = queue.dequeue()!;

                            // Strip relatedTask metadata when dequeuing for delivery
                            // The metadata was used for queuing, but shouldn't be sent to the client
                            const messageToSend = { ...queuedMessage.message };
                            if (messageToSend.params?._meta?.[RELATED_TASK_META_KEY]) {
                                const metaCopy = { ...messageToSend.params._meta };
                                delete metaCopy[RELATED_TASK_META_KEY];
                                messageToSend.params = {
                                    ...messageToSend.params,
                                    _meta: metaCopy
                                };
                            }

                            // Send the message on the response stream by passing the relatedRequestId
                            // This tells the transport to write the message to the tasks/result response stream
                            await this._transport?.send(messageToSend, { relatedRequestId: extra.requestId });

                            // If it was a request, wait for the response before delivering the next message
                            if (queuedMessage.type === 'request' && queuedMessage.responseResolver) {
                                // Wait for response before continuing to next message
                                await new Promise<void>((resolve, reject) => {
                                    const originalResolver = queuedMessage.responseResolver!;
                                    const wrappedResolver = (response: JSONRPCResponse | Error) => {
                                        // First, deliver the response to the task handler
                                        originalResolver(response);
                                        // Then, signal that we can continue delivering messages
                                        if (response instanceof Error) {
                                            reject(response);
                                        } else {
                                            resolve();
                                        }
                                    };
                                    // Replace the resolver so _onresponse calls our wrapped version
                                    if (queuedMessage.originalRequestId !== undefined) {
                                        this._requestResolvers.set(queuedMessage.originalRequestId, wrappedResolver);
                                    }
                                });
                            }
                        }
                    }

                    // Now check task status
                    const task = await this._taskStore!.getTask(taskId, extra.sessionId);
                    if (!task) {
                        throw new McpError(ErrorCode.InvalidParams, `Task not found: ${taskId}`);
                    }

                    // Block if task is not terminal and no messages to deliver
                    if (!isTerminal(task.status) && (!queue || queue.isEmpty())) {
                        // Wait for status change or new messages
                        await this._waitForTaskUpdate(taskId, extra.signal);

                        // After waking up, recursively call to deliver any new messages or result
                        return await handleTaskResult();
                    }

                    // If task is terminal, return the result
                    if (isTerminal(task.status)) {
                        const result = await this._taskStore!.getTaskResult(taskId, extra.sessionId);

                        this._clearTaskQueue(taskId);

                        return {
                            ...result,
                            _meta: {
                                ...result._meta,
                                [RELATED_TASK_META_KEY]: {
                                    taskId: taskId
                                }
                            }
                        } as SendResultT;
                    }

                    return await handleTaskResult();
                };

                return await handleTaskResult();
            });

            this.setRequestHandler(ListTasksRequestSchema, async (request, extra) => {
                try {
                    const { tasks, nextCursor } = await this._taskStore!.listTasks(request.params?.cursor, extra.sessionId);
                    // @ts-expect-error SendResultT cannot contain ListTasksResult, but we include it in our derived types everywhere else
                    return {
                        tasks,
                        nextCursor,
                        _meta: {}
                    } as SendResultT;
                } catch (error) {
                    throw new McpError(
                        ErrorCode.InvalidParams,
                        `Failed to list tasks: ${error instanceof Error ? error.message : String(error)}`
                    );
                }
            });

            this.setRequestHandler(CancelTaskRequestSchema, async (request, extra) => {
                try {
                    // Get the current task to check if it's in a terminal state, in case the implementation is not atomic
                    const task = await this._taskStore!.getTask(request.params.taskId, extra.sessionId);

                    if (!task) {
                        throw new McpError(ErrorCode.InvalidParams, `Task not found: ${request.params.taskId}`);
                    }

                    // Reject cancellation of terminal tasks
                    if (isTerminal(task.status)) {
                        throw new McpError(ErrorCode.InvalidParams, `Cannot cancel task in terminal status: ${task.status}`);
                    }

                    await this._taskStore!.updateTaskStatus(
                        request.params.taskId,
                        'cancelled',
                        'Client cancelled task execution.',
                        extra.sessionId
                    );

                    this._clearTaskQueue(request.params.taskId);

                    return {
                        _meta: {}
                    } as SendResultT;
                } catch (error) {
                    // Re-throw McpError as-is
                    if (error instanceof McpError) {
                        throw error;
                    }
                    throw new McpError(
                        ErrorCode.InvalidRequest,
                        `Failed to cancel task: ${error instanceof Error ? error.message : String(error)}`
                    );
                }
            });
        }
    }

    private async _oncancel(notification: CancelledNotification): Promise<void> {
        // Handle request cancellation
        const controller = this._requestHandlerAbortControllers.get(notification.params.requestId);
        controller?.abort(notification.params.reason);
    }

    private _setupTimeout(
        messageId: number,
        timeout: number,
        maxTotalTimeout: number | undefined,
        onTimeout: () => void,
        resetTimeoutOnProgress: boolean = false
    ) {
        this._timeoutInfo.set(messageId, {
            timeoutId: setTimeout(onTimeout, timeout),
            startTime: Date.now(),
            timeout,
            maxTotalTimeout,
            resetTimeoutOnProgress,
            onTimeout
        });
    }

    private _resetTimeout(messageId: number): boolean {
        const info = this._timeoutInfo.get(messageId);
        if (!info) return false;

        const totalElapsed = Date.now() - info.startTime;
        if (info.maxTotalTimeout && totalElapsed >= info.maxTotalTimeout) {
            this._timeoutInfo.delete(messageId);
            throw new McpError(ErrorCode.RequestTimeout, 'Maximum total timeout exceeded', {
                maxTotalTimeout: info.maxTotalTimeout,
                totalElapsed
            });
        }

        clearTimeout(info.timeoutId);
        info.timeoutId = setTimeout(info.onTimeout, info.timeout);
        return true;
    }

    private _cleanupTimeout(messageId: number) {
        const info = this._timeoutInfo.get(messageId);
        if (info) {
            clearTimeout(info.timeoutId);
            this._timeoutInfo.delete(messageId);
        }
    }

    /**
     * Attaches to the given transport, starts it, and starts listening for messages.
     *
     * The Protocol object assumes ownership of the Transport, replacing any callbacks that have already been set, and expects that it is the only user of the Transport instance going forward.
     */
    async connect(transport: Transport): Promise<void> {
        this._transport = transport;
        const _onclose = this.transport?.onclose;
        this._transport.onclose = () => {
            _onclose?.();
            this._onclose();
        };

        const _onerror = this.transport?.onerror;
        this._transport.onerror = (error: Error) => {
            _onerror?.(error);
            this._onerror(error);
        };

        const _onmessage = this._transport?.onmessage;
        this._transport.onmessage = (message, extra) => {
            _onmessage?.(message, extra);
            if (isJSONRPCResponse(message) || isJSONRPCError(message)) {
                this._onresponse(message);
            } else if (isJSONRPCRequest(message)) {
                this._onrequest(message, extra);
            } else if (isJSONRPCNotification(message)) {
                this._onnotification(message);
            } else {
                this._onerror(new Error(`Unknown message type: ${JSON.stringify(message)}`));
            }
        };

        await this._transport.start();
    }

    private _onclose(): void {
        const responseHandlers = this._responseHandlers;
        this._responseHandlers = new Map();
        this._progressHandlers.clear();
        this._taskProgressTokens.clear();
        this._pendingDebouncedNotifications.clear();

        const error = new McpError(ErrorCode.ConnectionClosed, 'Connection closed');

        this._transport = undefined;
        this.onclose?.();

        for (const handler of responseHandlers.values()) {
            handler(error);
        }
    }

    private _onerror(error: Error): void {
        this.onerror?.(error);
    }

    private _onnotification(notification: JSONRPCNotification): void {
        const handler = this._notificationHandlers.get(notification.method) ?? this.fallbackNotificationHandler;

        // Ignore notifications not being subscribed to.
        if (handler === undefined) {
            return;
        }

        // Starting with Promise.resolve() puts any synchronous errors into the monad as well.
        Promise.resolve()
            .then(() => handler(notification))
            .catch(error => this._onerror(new Error(`Uncaught error in notification handler: ${error}`)));
    }

    private _onrequest(request: JSONRPCRequest, extra?: MessageExtraInfo): void {
        const handler = this._requestHandlers.get(request.method) ?? this.fallbackRequestHandler;

        // Capture the current transport at request time to ensure responses go to the correct client
        const capturedTransport = this._transport;

        if (handler === undefined) {
            capturedTransport
                ?.send({
                    jsonrpc: '2.0',
                    id: request.id,
                    error: {
                        code: ErrorCode.MethodNotFound,
                        message: 'Method not found'
                    }
                })
                .catch(error => this._onerror(new Error(`Failed to send an error response: ${error}`)));
            return;
        }

        const abortController = new AbortController();
        this._requestHandlerAbortControllers.set(request.id, abortController);

        const taskCreationParams = request.params?.task;
        const taskStore = this._taskStore ? this.requestTaskStore(request, capturedTransport?.sessionId) : undefined;

        // Extract taskId from request metadata if present
        const relatedTaskId = request.params?._meta?.[RELATED_TASK_META_KEY]?.taskId;

        const fullExtra: RequestHandlerExtra<SendRequestT, SendNotificationT> = {
            signal: abortController.signal,
            sessionId: capturedTransport?.sessionId,
            _meta: request.params?._meta,
            sendNotification: async notification => {
                // Include related-task metadata if this request is part of a task
                const notificationOptions: NotificationOptions = { relatedRequestId: request.id };
                if (relatedTaskId) {
                    notificationOptions.relatedTask = { taskId: relatedTaskId };
                }
                await this.notification(notification, notificationOptions);
            },
            sendRequest: async (r, resultSchema, options?) => {
                // Include related-task metadata if this request is part of a task
                const requestOptions: RequestOptions = { ...options, relatedRequestId: request.id };
                if (relatedTaskId && !requestOptions.relatedTask) {
                    requestOptions.relatedTask = { taskId: relatedTaskId };
                }
                return await this.request(r, resultSchema, requestOptions);
            },
            authInfo: extra?.authInfo,
            requestId: request.id,
            requestInfo: extra?.requestInfo,
            taskId: relatedTaskId,
            taskStore: taskStore,
            taskRequestedTtl: taskCreationParams?.ttl
        };

        // Starting with Promise.resolve() puts any synchronous errors into the monad as well.
        Promise.resolve()
            .then(() => {
                // If this request asked for task creation, check capability first
                if (taskCreationParams) {
                    // Check if the request method supports task creation
                    this.assertTaskHandlerCapability(request.method);
                }
            })
            .then(() => handler(request, fullExtra))
            .then(
                async result => {
                    if (abortController.signal.aborted) {
                        // Request was cancelled
                        return;
                    }

                    // Send the response
                    await capturedTransport?.send({
                        result,
                        jsonrpc: '2.0',
                        id: request.id
                    });
                },
                async error => {
                    if (abortController.signal.aborted) {
                        // Request was cancelled
                        return;
                    }

                    return capturedTransport?.send({
                        jsonrpc: '2.0',
                        id: request.id,
                        error: {
                            code: Number.isSafeInteger(error['code']) ? error['code'] : ErrorCode.InternalError,
                            message: error.message ?? 'Internal error'
                        }
                    });
                }
            )
            .catch(error => this._onerror(new Error(`Failed to send response: ${error}`)))
            .finally(() => {
                this._requestHandlerAbortControllers.delete(request.id);
            });
    }

    private _onprogress(notification: ProgressNotification): void {
        const { progressToken, ...params } = notification.params;
        const messageId = Number(progressToken);

        const handler = this._progressHandlers.get(messageId);
        if (!handler) {
            this._onerror(new Error(`Received a progress notification for an unknown token: ${JSON.stringify(notification)}`));
            return;
        }

        const responseHandler = this._responseHandlers.get(messageId);
        const timeoutInfo = this._timeoutInfo.get(messageId);

        if (timeoutInfo && responseHandler && timeoutInfo.resetTimeoutOnProgress) {
            try {
                this._resetTimeout(messageId);
            } catch (error) {
                // Clean up if maxTotalTimeout was exceeded
                this._responseHandlers.delete(messageId);
                this._progressHandlers.delete(messageId);
                this._cleanupTimeout(messageId);
                responseHandler(error as Error);
                return;
            }
        }

        handler(params);
    }

    private _onresponse(response: JSONRPCResponse | JSONRPCError): void {
        const messageId = Number(response.id);

        // Check if this is a response to a queued request
        const resolver = this._requestResolvers.get(messageId);
        if (resolver) {
            this._requestResolvers.delete(messageId);
            if (isJSONRPCResponse(response)) {
                resolver(response);
            } else {
                const error = new McpError(response.error.code, response.error.message, response.error.data);
                resolver(error);
            }
            return;
        }

        const handler = this._responseHandlers.get(messageId);
        if (handler === undefined) {
            this._onerror(new Error(`Received a response for an unknown message ID: ${JSON.stringify(response)}`));
            return;
        }

        this._responseHandlers.delete(messageId);
        this._cleanupTimeout(messageId);

        // Keep progress handler alive for CreateTaskResult responses
        let isTaskResponse = false;
        if (isJSONRPCResponse(response) && response.result && typeof response.result === 'object') {
            const result = response.result as Record<string, unknown>;
            if (result.task && typeof result.task === 'object') {
                const task = result.task as Record<string, unknown>;
                if (typeof task.taskId === 'string') {
                    isTaskResponse = true;
                    this._taskProgressTokens.set(task.taskId, messageId);
                }
            }
        }

        if (!isTaskResponse) {
            this._progressHandlers.delete(messageId);
        }

        if (isJSONRPCResponse(response)) {
            handler(response);
        } else {
            const error = new McpError(response.error.code, response.error.message, response.error.data);
            handler(error);
        }
    }

    get transport(): Transport | undefined {
        return this._transport;
    }

    /**
     * Closes the connection.
     */
    async close(): Promise<void> {
        await this._transport?.close();
    }

    /**
     * A method to check if a capability is supported by the remote side, for the given method to be called.
     *
     * This should be implemented by subclasses.
     */
    protected abstract assertCapabilityForMethod(method: SendRequestT['method']): void;

    /**
     * A method to check if a notification is supported by the local side, for the given method to be sent.
     *
     * This should be implemented by subclasses.
     */
    protected abstract assertNotificationCapability(method: SendNotificationT['method']): void;

    /**
     * A method to check if a request handler is supported by the local side, for the given method to be handled.
     *
     * This should be implemented by subclasses.
     */
    protected abstract assertRequestHandlerCapability(method: string): void;

    /**
     * A method to check if task creation is supported for the given request method.
     *
     * This should be implemented by subclasses.
     */
    protected abstract assertTaskCapability(method: string): void;

    /**
     * A method to check if task handler is supported by the local side, for the given method to be handled.
     *
     * This should be implemented by subclasses.
     */
    protected abstract assertTaskHandlerCapability(method: string): void;

    /**
     * Sends a request and returns an AsyncGenerator that yields response messages.
     * The generator is guaranteed to end with either a 'result' or 'error' message.
     *
     * @example
     * ```typescript
     * const stream = protocol.requestStream(request, resultSchema, options);
     * for await (const message of stream) {
     *   switch (message.type) {
     *     case 'taskCreated':
     *       console.log('Task created:', message.task.taskId);
     *       break;
     *     case 'taskStatus':
     *       console.log('Task status:', message.task.status);
     *       break;
     *     case 'result':
     *       console.log('Final result:', message.result);
     *       break;
     *     case 'error':
     *       console.error('Error:', message.error);
     *       break;
     *   }
     * }
     * ```
     */
    async *requestStream<T extends ZodType<Result>>(
        request: SendRequestT,
        resultSchema: T,
        options?: RequestOptions
    ): AsyncGenerator<ResponseMessage<z.infer<T>>, void, void> {
        const { task } = options ?? {};

        // For non-task requests, just yield the result
        if (!task) {
            try {
                const result = await this.request(request, resultSchema, options);
                yield { type: 'result', result };
            } catch (error) {
                yield {
                    type: 'error',
                    error: error instanceof McpError ? error : new McpError(ErrorCode.InternalError, String(error))
                };
            }
            return;
        }

        // For task-augmented requests, we need to poll for status
        // First, make the request to create the task
        let taskId: string | undefined;
        try {
            // Send the request and get the CreateTaskResult
            const createResult = await this.request(request, CreateTaskResultSchema as unknown as T, options);

            // Extract taskId from the result
            if ('task' in createResult && typeof createResult.task === 'object' && createResult.task && 'taskId' in createResult.task) {
                taskId = (createResult.task as { taskId: string }).taskId;
                yield { type: 'taskCreated', task: createResult.task as Task };
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
                    if (task.status === 'completed') {
                        // Get the final result
                        const result = await this.getTaskResult({ taskId }, resultSchema, options);
                        yield { type: 'result', result };
                    } else if (task.status === 'failed') {
                        yield {
                            type: 'error',
                            error: new McpError(ErrorCode.InternalError, `Task ${taskId} failed`)
                        };
                    } else if (task.status === 'cancelled') {
                        yield {
                            type: 'error',
                            error: new McpError(ErrorCode.InternalError, `Task ${taskId} was cancelled`)
                        };
                    }
                    return;
                }

                // Wait before polling again
                const pollInterval = task.pollInterval ?? 1000;
                await new Promise(resolve => setTimeout(resolve, pollInterval));

                // Check if cancelled
                options?.signal?.throwIfAborted();
            }
        } catch (error) {
            yield {
                type: 'error',
                error: error instanceof McpError ? error : new McpError(ErrorCode.InternalError, String(error))
            };
        }
    }

    /**
     * Sends a request and waits for a response.
     *
     * Do not use this method to emit notifications! Use notification() instead.
     */
    request<T extends ZodType<Result>>(request: SendRequestT, resultSchema: T, options?: RequestOptions): Promise<z.infer<T>> {
        const { relatedRequestId, resumptionToken, onresumptiontoken, task, relatedTask } = options ?? {};

        // Send the request
        return new Promise<z.infer<T>>((resolve, reject) => {
            const earlyReject = (error: unknown) => {
                reject(error);
            };

            if (!this._transport) {
                earlyReject(new Error('Not connected'));
                return;
            }

            if (this._options?.enforceStrictCapabilities === true) {
                try {
                    this.assertCapabilityForMethod(request.method);

                    // If task creation is requested, also check task capabilities
                    if (task) {
                        this.assertTaskCapability(request.method);
                    }
                } catch (e) {
                    earlyReject(e);
                    return;
                }
            }

            options?.signal?.throwIfAborted();

            const messageId = this._requestMessageId++;
            const jsonrpcRequest: JSONRPCRequest = {
                ...request,
                jsonrpc: '2.0',
                id: messageId
            };

            if (options?.onprogress) {
                this._progressHandlers.set(messageId, options.onprogress);
                jsonrpcRequest.params = {
                    ...request.params,
                    _meta: {
                        ...(request.params?._meta || {}),
                        progressToken: messageId
                    }
                };
            }

            // Augment with task creation parameters if provided
            if (task) {
                jsonrpcRequest.params = {
                    ...jsonrpcRequest.params,
                    task: task
                };
            }

            // Augment with related task metadata if relatedTask is provided
            if (relatedTask) {
                jsonrpcRequest.params = {
                    ...jsonrpcRequest.params,
                    _meta: {
                        ...(jsonrpcRequest.params?._meta || {}),
                        [RELATED_TASK_META_KEY]: relatedTask
                    }
                };
            }

            const cancel = (reason: unknown) => {
                this._responseHandlers.delete(messageId);
                this._progressHandlers.delete(messageId);
                this._cleanupTimeout(messageId);

                this._transport
                    ?.send(
                        {
                            jsonrpc: '2.0',
                            method: 'notifications/cancelled',
                            params: {
                                requestId: messageId,
                                reason: String(reason)
                            }
                        },
                        { relatedRequestId, resumptionToken, onresumptiontoken }
                    )
                    .catch(error => this._onerror(new Error(`Failed to send cancellation: ${error}`)));

                // Wrap the reason in an McpError if it isn't already
                const error = reason instanceof McpError ? reason : new McpError(ErrorCode.RequestTimeout, String(reason));
                reject(error);
            };

            this._responseHandlers.set(messageId, response => {
                if (options?.signal?.aborted) {
                    return;
                }

                if (response instanceof Error) {
                    return reject(response);
                }

                try {
                    const result = resultSchema.parse(response.result);
                    resolve(result);
                } catch (error) {
                    reject(error);
                }
            });

            options?.signal?.addEventListener('abort', () => {
                cancel(options?.signal?.reason);
            });

            const timeout = options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC;
            const timeoutHandler = () => cancel(new McpError(ErrorCode.RequestTimeout, 'Request timed out', { timeout }));

            this._setupTimeout(messageId, timeout, options?.maxTotalTimeout, timeoutHandler, options?.resetTimeoutOnProgress ?? false);

            // Queue request if related to a task
            const relatedTaskId = relatedTask?.taskId;
            if (relatedTaskId) {
                // Store the response resolver for this request so responses can be routed back
                const responseResolver = (response: JSONRPCResponse | Error) => {
                    const handler = this._responseHandlers.get(messageId);
                    if (handler) {
                        handler(response);
                    } else {
                        // Log error when resolver is missing, but don't fail
                        this._onerror(new Error(`Response handler missing for side-channeled request ${messageId}`));
                    }
                };
                this._requestResolvers.set(messageId, responseResolver);

                try {
                    this._enqueueTaskMessage(relatedTaskId, {
                        type: 'request',
                        message: jsonrpcRequest,
                        timestamp: Date.now(),
                        responseResolver: responseResolver,
                        originalRequestId: messageId
                    });

                    // Notify any waiting tasks/result calls
                    this._notifyTaskResultWaiters(relatedTaskId);
                } catch (error) {
                    this._cleanupTimeout(messageId);
                    reject(error);
                    return;
                }

                // Don't send through transport - queued messages are delivered via tasks/result only
                // This prevents duplicate delivery for bidirectional transports
            } else {
                // No related task - send through transport normally
                this._transport.send(jsonrpcRequest, { relatedRequestId, resumptionToken, onresumptiontoken }).catch(error => {
                    this._cleanupTimeout(messageId);
                    reject(error);
                });
            }
        });
    }

    /**
     * Gets the current status of a task.
     */
    async getTask(params: GetTaskRequest['params'], options?: RequestOptions): Promise<GetTaskResult> {
        // @ts-expect-error SendRequestT cannot directly contain GetTaskRequest, but we ensure all type instantiations contain it anyways
        return this.request({ method: 'tasks/get', params }, GetTaskResultSchema, options);
    }

    /**
     * Retrieves the result of a completed task.
     */
    async getTaskResult<T extends ZodType<Result>>(
        params: GetTaskPayloadRequest['params'],
        resultSchema: T,
        options?: RequestOptions
    ): Promise<z.infer<T>> {
        // @ts-expect-error SendRequestT cannot directly contain GetTaskPayloadRequest, but we ensure all type instantiations contain it anyways
        return this.request({ method: 'tasks/result', params }, resultSchema, options);
    }

    /**
     * Lists tasks, optionally starting from a pagination cursor.
     */
    async listTasks(params?: { cursor?: string }, options?: RequestOptions): Promise<z.infer<typeof ListTasksResultSchema>> {
        // @ts-expect-error SendRequestT cannot directly contain ListTasksRequest, but we ensure all type instantiations contain it anyways
        return this.request({ method: 'tasks/list', params }, ListTasksResultSchema, options);
    }

    /**
     * Cancels a specific task.
     */
    async cancelTask(params: { taskId: string }, options?: RequestOptions): Promise<z.infer<typeof CancelTaskResultSchema>> {
        // @ts-expect-error SendRequestT cannot directly contain CancelTaskRequest, but we ensure all type instantiations contain it anyways
        return this.request({ method: 'tasks/cancel', params }, CancelTaskResultSchema, options);
    }

    /**
     * Emits a notification, which is a one-way message that does not expect a response.
     */
    async notification(notification: SendNotificationT, options?: NotificationOptions): Promise<void> {
        if (!this._transport) {
            throw new Error('Not connected');
        }

        this.assertNotificationCapability(notification.method);

        // Queue notification if related to a task
        const relatedTaskId = options?.relatedTask?.taskId;
        if (relatedTaskId) {
            // Build the JSONRPC notification with metadata
            const jsonrpcNotification: JSONRPCNotification = {
                ...notification,
                jsonrpc: '2.0',
                params: {
                    ...notification.params,
                    _meta: {
                        ...(notification.params?._meta || {}),
                        [RELATED_TASK_META_KEY]: options.relatedTask
                    }
                }
            };

            this._enqueueTaskMessage(relatedTaskId, {
                type: 'notification',
                message: jsonrpcNotification,
                timestamp: Date.now()
            });

            // Notify any waiting tasks/result calls
            this._notifyTaskResultWaiters(relatedTaskId);

            // Don't send through transport - queued messages are delivered via tasks/result only
            // This prevents duplicate delivery for bidirectional transports
            return;
        }

        const debouncedMethods = this._options?.debouncedNotificationMethods ?? [];
        // A notification can only be debounced if it's in the list AND it's "simple"
        // (i.e., has no parameters and no related request ID or related task that could be lost).
        const canDebounce =
            debouncedMethods.includes(notification.method) && !notification.params && !options?.relatedRequestId && !options?.relatedTask;

        if (canDebounce) {
            // If a notification of this type is already scheduled, do nothing.
            if (this._pendingDebouncedNotifications.has(notification.method)) {
                return;
            }

            // Mark this notification type as pending.
            this._pendingDebouncedNotifications.add(notification.method);

            // Schedule the actual send to happen in the next microtask.
            // This allows all synchronous calls in the current event loop tick to be coalesced.
            Promise.resolve().then(() => {
                // Un-mark the notification so the next one can be scheduled.
                this._pendingDebouncedNotifications.delete(notification.method);

                // SAFETY CHECK: If the connection was closed while this was pending, abort.
                if (!this._transport) {
                    return;
                }

                let jsonrpcNotification: JSONRPCNotification = {
                    ...notification,
                    jsonrpc: '2.0'
                };

                // Augment with related task metadata if relatedTask is provided
                if (options?.relatedTask) {
                    jsonrpcNotification = {
                        ...jsonrpcNotification,
                        params: {
                            ...jsonrpcNotification.params,
                            _meta: {
                                ...(jsonrpcNotification.params?._meta || {}),
                                [RELATED_TASK_META_KEY]: options.relatedTask
                            }
                        }
                    };
                }

                // Send the notification, but don't await it here to avoid blocking.
                // Handle potential errors with a .catch().
                this._transport?.send(jsonrpcNotification, options).catch(error => this._onerror(error));
            });

            // Return immediately.
            return;
        }

        let jsonrpcNotification: JSONRPCNotification = {
            ...notification,
            jsonrpc: '2.0'
        };

        // Augment with related task metadata if relatedTask is provided
        if (options?.relatedTask) {
            jsonrpcNotification = {
                ...jsonrpcNotification,
                params: {
                    ...jsonrpcNotification.params,
                    _meta: {
                        ...(jsonrpcNotification.params?._meta || {}),
                        [RELATED_TASK_META_KEY]: options.relatedTask
                    }
                }
            };
        }

        await this._transport.send(jsonrpcNotification, options);
    }

    /**
     * Registers a handler to invoke when this protocol object receives a request with the given method.
     *
     * Note that this will replace any previous request handler for the same method.
     */
    setRequestHandler<
        T extends ZodObject<{
            method: ZodLiteral<string>;
        }>
    >(
        requestSchema: T,
        handler: (request: z.infer<T>, extra: RequestHandlerExtra<SendRequestT, SendNotificationT>) => SendResultT | Promise<SendResultT>
    ): void {
        const method = requestSchema.shape.method.value;
        this.assertRequestHandlerCapability(method);

        this._requestHandlers.set(method, (request, extra) => {
            return Promise.resolve(handler(requestSchema.parse(request), extra));
        });
    }

    /**
     * Removes the request handler for the given method.
     */
    removeRequestHandler(method: string): void {
        this._requestHandlers.delete(method);
    }

    /**
     * Asserts that a request handler has not already been set for the given method, in preparation for a new one being automatically installed.
     */
    assertCanSetRequestHandler(method: string): void {
        if (this._requestHandlers.has(method)) {
            throw new Error(`A request handler for ${method} already exists, which would be overridden`);
        }
    }

    /**
     * Registers a handler to invoke when this protocol object receives a notification with the given method.
     *
     * Note that this will replace any previous notification handler for the same method.
     */
    setNotificationHandler<
        T extends ZodObject<{
            method: ZodLiteral<string>;
        }>
    >(notificationSchema: T, handler: (notification: z.infer<T>) => void | Promise<void>): void {
        this._notificationHandlers.set(notificationSchema.shape.method.value, notification =>
            Promise.resolve(handler(notificationSchema.parse(notification)))
        );
    }

    /**
     * Removes the notification handler for the given method.
     */
    removeNotificationHandler(method: string): void {
        this._notificationHandlers.delete(method);
    }

    /**
     * Cleans up the progress handler associated with a task.
     * This should be called when a task reaches a terminal status.
     */
    private _cleanupTaskProgressHandler(taskId: string): void {
        const progressToken = this._taskProgressTokens.get(taskId);
        if (progressToken !== undefined) {
            this._progressHandlers.delete(progressToken);
            this._taskProgressTokens.delete(taskId);
        }
    }

    /**
     * Enqueues a task-related message for side-channel delivery via tasks/result.
     * @param taskId The task ID to associate the message with
     * @param message The message to enqueue
     * @throws McpError if the queue size exceeds the configured maximum
     */
    private _enqueueTaskMessage(taskId: string, message: QueuedMessage): void {
        let queue = this._taskMessageQueues.get(taskId);
        if (!queue) {
            queue = new TaskMessageQueue();
            this._taskMessageQueues.set(taskId, queue);
        }

        const maxQueueSize = this._options?.maxTaskQueueSize;
        if (maxQueueSize !== undefined && queue.size() >= maxQueueSize) {
            const errorMessage = `Task message queue overflow: queue size (${queue.size()}) exceeds maximum (${maxQueueSize})`;

            // Log the error for debugging
            this._onerror(new Error(errorMessage));

            this._taskStore?.updateTaskStatus(taskId, 'failed', 'Task message queue overflow').catch(err => this._onerror(err));
            this._clearTaskQueue(taskId);

            throw new McpError(ErrorCode.InternalError, 'Task message queue overflow');
        }

        queue.enqueue(message);
    }

    /**
     * Clears the message queue for a task and rejects any pending request resolvers.
     * @param taskId The task ID whose queue should be cleared
     */
    private _clearTaskQueue(taskId: string): void {
        const queue = this._taskMessageQueues.get(taskId);
        if (queue) {
            // Reject any pending request resolvers
            for (const message of queue.dequeueAll()) {
                if (message.type === 'request' && message.responseResolver && message.originalRequestId !== undefined) {
                    message.responseResolver(new McpError(ErrorCode.InternalError, 'Task cancelled or completed'));
                    // Clean up the resolver mapping
                    this._requestResolvers.delete(message.originalRequestId);
                }
            }
            this._taskMessageQueues.delete(taskId);
        }
    }

    /**
     * Notifies any waiting tasks/result calls that new messages are available or task status changed.
     * @param taskId The task ID to notify waiters for
     */
    private _notifyTaskResultWaiters(taskId: string): void {
        const waiters = this._taskResultWaiters.get(taskId);
        if (waiters) {
            for (const waiter of waiters) {
                waiter();
            }
            this._taskResultWaiters.delete(taskId);
        }
    }

    /**
     * Waits for a task update (new messages or status change) with abort signal support.
     * This method uses a hybrid approach:
     * 1. Primary: Event-driven notifications via _notifyTaskResultWaiters() when messages
     *    are queued or task status changes
     * 2. Fallback: Lightweight polling (every 100ms) to handle edge cases and race conditions
     *
     * The polling serves as a safety net for scenarios where notifications might be missed
     * due to timing issues, but the event-driven approach handles the majority of cases.
     * @param taskId The task ID to wait for
     * @param signal Abort signal to cancel the wait
     * @returns Promise that resolves when an update occurs or rejects if aborted
     */
    private async _waitForTaskUpdate(taskId: string, signal: AbortSignal): Promise<void> {
        return new Promise((resolve, reject) => {
            if (signal.aborted) {
                reject(new McpError(ErrorCode.InvalidRequest, 'Request cancelled'));
                return;
            }

            const waiters = this._taskResultWaiters.get(taskId) || [];
            waiters.push(resolve);
            this._taskResultWaiters.set(taskId, waiters);

            signal.addEventListener(
                'abort',
                () => {
                    reject(new McpError(ErrorCode.InvalidRequest, 'Request cancelled'));
                },
                { once: true }
            );

            // Polling as a fallback mechanism for edge cases and race conditions
            // Most updates will be handled by event-driven notifications via _notifyTaskResultWaiters()
            const pollInterval = setInterval(async () => {
                try {
                    const task = await this._taskStore?.getTask(taskId);
                    if (task && (isTerminal(task.status) || this._taskMessageQueues.get(taskId)?.size())) {
                        clearInterval(pollInterval);
                        this._notifyTaskResultWaiters(taskId);
                    }
                } catch {
                    // Ignore errors during polling
                }
            }, 100);

            // Clean up the interval when the promise resolves or rejects
            const cleanup = () => clearInterval(pollInterval);
            signal.addEventListener('abort', cleanup, { once: true });
        });
    }

    private requestTaskStore(request?: JSONRPCRequest, sessionId?: string): RequestTaskStore {
        const taskStore = this._taskStore;
        if (!taskStore) {
            throw new Error('No task store configured');
        }

        return {
            createTask: async taskParams => {
                if (!request) {
                    throw new Error('No request provided');
                }

                return await taskStore.createTask(
                    taskParams,
                    request.id,
                    {
                        method: request.method,
                        params: request.params
                    },
                    sessionId
                );
            },
            getTask: async taskId => {
                const task = await taskStore.getTask(taskId, sessionId);
                if (!task) {
                    throw new McpError(ErrorCode.InvalidParams, 'Failed to retrieve task: Task not found');
                }

                return task;
            },
            storeTaskResult: async (taskId, status, result) => {
                await taskStore.storeTaskResult(taskId, status, result, sessionId);

                // Get updated task state and send notification
                const task = await taskStore.getTask(taskId, sessionId);
                if (task) {
                    const notification: TaskStatusNotification = TaskStatusNotificationSchema.parse({
                        method: 'notifications/tasks/status',
                        params: {
                            task
                        }
                    });
                    await this.notification(notification as SendNotificationT);

                    if (isTerminal(task.status)) {
                        this._cleanupTaskProgressHandler(taskId);
                        // Don't clear queue here - it will be cleared after delivery via tasks/result
                        // this._clearTaskQueue(taskId);
                    }
                }
            },
            getTaskResult: taskId => {
                return taskStore.getTaskResult(taskId, sessionId);
            },
            updateTaskStatus: async (taskId, status, statusMessage) => {
                try {
                    // Check if task is in terminal state before attempting to update
                    const task = await taskStore.getTask(taskId, sessionId);
                    if (!task) {
                        return;
                    }

                    // Don't allow transitions from terminal states
                    if (isTerminal(task.status)) {
                        this._onerror(
                            new Error(
                                `Cannot update task "${taskId}" from terminal status "${task.status}" to "${status}". Terminal states (completed, failed, cancelled) cannot transition to other states.`
                            )
                        );
                        return;
                    }

                    await taskStore.updateTaskStatus(taskId, status, statusMessage, sessionId);

                    // Get updated task state and send notification
                    const updatedTask = await taskStore.getTask(taskId, sessionId);
                    if (updatedTask) {
                        const notification: TaskStatusNotification = TaskStatusNotificationSchema.parse({
                            method: 'notifications/tasks/status',
                            params: {
                                task: updatedTask
                            }
                        });
                        await this.notification(notification as SendNotificationT);

                        if (isTerminal(updatedTask.status)) {
                            this._cleanupTaskProgressHandler(taskId);
                            // Don't clear queue here - it will be cleared after delivery via tasks/result
                            // this._clearTaskQueue(taskId);
                        }
                    }
                } catch (error) {
                    throw new Error(`Failed to update status of task "${taskId}" to "${status}": ${error}`);
                }
            },
            listTasks: cursor => {
                return taskStore.listTasks(cursor, sessionId);
            }
        };
    }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function mergeCapabilities(base: ServerCapabilities, additional: Partial<ServerCapabilities>): ServerCapabilities;
export function mergeCapabilities(base: ClientCapabilities, additional: Partial<ClientCapabilities>): ClientCapabilities;
export function mergeCapabilities<T extends ServerCapabilities | ClientCapabilities>(base: T, additional: Partial<T>): T {
    const result: T = { ...base };
    for (const key in additional) {
        const k = key as keyof T;
        const addValue = additional[k];
        if (addValue === undefined) continue;
        const baseValue = result[k];
        if (isPlainObject(baseValue) && isPlainObject(addValue)) {
            result[k] = { ...(baseValue as Record<string, unknown>), ...(addValue as Record<string, unknown>) } as T[typeof k];
        } else {
            result[k] = addValue as T[typeof k];
        }
    }
    return result;
}
