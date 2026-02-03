import { SdkError, SdkErrorCode } from '../errors/sdkErrors.js';
import type { CreateTaskOptions, QueuedMessage, TaskMessageQueue, TaskStore } from '../experimental/tasks/interfaces.js';
import { isTerminal } from '../experimental/tasks/interfaces.js';
import type {
    AuthInfo,
    CancelledNotification,
    ClientCapabilities,
    GetTaskPayloadRequest,
    GetTaskRequest,
    GetTaskResult,
    JSONRPCErrorResponse,
    JSONRPCNotification,
    JSONRPCRequest,
    JSONRPCResponse,
    JSONRPCResultResponse,
    MessageExtraInfo,
    Notification,
    NotificationMethod,
    NotificationTypeMap,
    Progress,
    ProgressNotification,
    RelatedTaskMetadata,
    Request,
    RequestId,
    RequestInfo,
    RequestMeta,
    RequestMethod,
    RequestTypeMap,
    Result,
    ServerCapabilities,
    Task,
    TaskCreationParams,
    TaskStatusNotification
} from '../types/types.js';
import {
    CancelTaskResultSchema,
    CreateTaskResultSchema,
    getNotificationSchema,
    getRequestSchema,
    GetTaskResultSchema,
    isJSONRPCErrorResponse,
    isJSONRPCNotification,
    isJSONRPCRequest,
    isJSONRPCResultResponse,
    isTaskAugmentedRequestParams,
    ListTasksResultSchema,
    ProtocolError,
    ProtocolErrorCode,
    RELATED_TASK_META_KEY,
    SUPPORTED_PROTOCOL_VERSIONS,
    TaskStatusNotificationSchema
} from '../types/types.js';
import type { AnyObjectSchema, AnySchema, SchemaOutput } from '../util/schema.js';
import { parseSchema } from '../util/schema.js';
import type { ResponseMessage } from './responseMessage.js';
import type { Transport, TransportSendOptions } from './transport.js';

/**
 * Callback for progress notifications.
 */
export type ProgressCallback = (progress: Progress) => void;

/**
 * Additional initialization options.
 */
export type ProtocolOptions = {
    /**
     * Protocol versions supported. First version is preferred (sent by client,
     * used as fallback by server). Passed to transport during connect().
     *
     * @default SUPPORTED_PROTOCOL_VERSIONS
     */
    supportedProtocolVersions?: string[];

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
     * Optional task message queue implementation for managing server-initiated messages
     * that will be delivered through the tasks/result response stream.
     */
    taskMessageQueue?: TaskMessageQueue;
    /**
     * Default polling interval (in milliseconds) for task status checks when no pollInterval
     * is provided by the server. Defaults to 5000ms if not specified.
     */
    defaultTaskPollInterval?: number;
    /**
     * Maximum number of messages that can be queued per task for side-channel delivery.
     * If undefined, the queue size is unbounded.
     * When the limit is exceeded, the TaskMessageQueue implementation's enqueue() method
     * will throw an error. It's the implementation's responsibility to handle overflow
     * appropriately (e.g., by failing the task, dropping messages, etc.).
     */
    maxTaskQueueSize?: number;
};

/**
 * The default request timeout, in miliseconds.
 */
export const DEFAULT_REQUEST_TIMEOUT_MSEC = 60_000;

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
     * A timeout (in milliseconds) for this request. If exceeded, an SdkError with code `SdkErrorCode.RequestTimeout` will be raised from request().
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
     * If exceeded, an SdkError with code `SdkErrorCode.RequestTimeout` will be raised, regardless of progress notifications.
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
    sendRequest: <U extends AnySchema>(request: SendRequestT, resultSchema: U, options?: TaskRequestOptions) => Promise<SchemaOutput<U>>;

    /**
     * Closes the SSE stream for this request, triggering client reconnection.
     * Only available when using a StreamableHTTPServerTransport with eventStore configured.
     * Use this to implement polling behavior during long-running operations.
     */
    closeSSEStream?: () => void;

    /**
     * Closes the standalone GET SSE stream, triggering client reconnection.
     * Only available when using a StreamableHTTPServerTransport with eventStore configured.
     * Use this to implement polling behavior for server-initiated notifications.
     */
    closeStandaloneSSEStream?: () => void;
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
    private _responseHandlers: Map<number, (response: JSONRPCResultResponse | Error) => void> = new Map();
    private _progressHandlers: Map<number, ProgressCallback> = new Map();
    private _timeoutInfo: Map<number, TimeoutInfo> = new Map();
    private _pendingDebouncedNotifications = new Set<string>();

    // Maps task IDs to progress tokens to keep handlers alive after CreateTaskResult
    private _taskProgressTokens: Map<string, number> = new Map();

    private _taskStore?: TaskStore;
    private _taskMessageQueue?: TaskMessageQueue;

    private _requestResolvers: Map<RequestId, (response: JSONRPCResultResponse | Error) => void> = new Map();

    protected _supportedProtocolVersions: string[];

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
        this._supportedProtocolVersions = _options?.supportedProtocolVersions ?? SUPPORTED_PROTOCOL_VERSIONS;

        this.setNotificationHandler('notifications/cancelled', notification => {
            this._oncancel(notification);
        });

        this.setNotificationHandler('notifications/progress', notification => {
            this._onprogress(notification);
        });

        this.setRequestHandler(
            'ping',
            // Automatic pong by default.
            _request => ({}) as SendResultT
        );

        // Install task handlers if TaskStore is provided
        this._taskStore = _options?.taskStore;
        this._taskMessageQueue = _options?.taskMessageQueue;
        if (this._taskStore) {
            this.setRequestHandler('tasks/get', async (request, extra) => {
                const task = await this._taskStore!.getTask(request.params.taskId, extra.sessionId);
                if (!task) {
                    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Failed to retrieve task: Task not found');
                }

                // Per spec: tasks/get responses SHALL NOT include related-task metadata
                // as the taskId parameter is the source of truth
                return {
                    ...task
                } as unknown as SendResultT;
            });

            this.setRequestHandler('tasks/result', async (request, extra) => {
                const handleTaskResult = async (): Promise<SendResultT> => {
                    const taskId = request.params.taskId;

                    // Deliver queued messages
                    if (this._taskMessageQueue) {
                        let queuedMessage: QueuedMessage | undefined;
                        while ((queuedMessage = await this._taskMessageQueue.dequeue(taskId, extra.sessionId))) {
                            // Handle response and error messages by routing them to the appropriate resolver
                            if (queuedMessage.type === 'response' || queuedMessage.type === 'error') {
                                const message = queuedMessage.message;
                                const requestId = message.id;

                                // Lookup resolver in _requestResolvers map
                                const resolver = this._requestResolvers.get(requestId as RequestId);

                                if (resolver) {
                                    // Remove resolver from map after invocation
                                    this._requestResolvers.delete(requestId as RequestId);

                                    // Invoke resolver with response or error
                                    if (queuedMessage.type === 'response') {
                                        resolver(message as JSONRPCResultResponse);
                                    } else {
                                        // Convert JSONRPCError to ProtocolError
                                        const errorMessage = message as JSONRPCErrorResponse;
                                        const error = new ProtocolError(
                                            errorMessage.error.code,
                                            errorMessage.error.message,
                                            errorMessage.error.data
                                        );
                                        resolver(error);
                                    }
                                } else {
                                    // Handle missing resolver gracefully with error logging
                                    const messageType = queuedMessage.type === 'response' ? 'Response' : 'Error';
                                    this._onerror(new Error(`${messageType} handler missing for request ${requestId}`));
                                }

                                // Continue to next message
                                continue;
                            }

                            // Send the message on the response stream by passing the relatedRequestId
                            // This tells the transport to write the message to the tasks/result response stream
                            await this._transport?.send(queuedMessage.message, { relatedRequestId: extra.requestId });
                        }
                    }

                    // Now check task status
                    const task = await this._taskStore!.getTask(taskId, extra.sessionId);
                    if (!task) {
                        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Task not found: ${taskId}`);
                    }

                    // Block if task is not terminal (we've already delivered all queued messages above)
                    if (!isTerminal(task.status)) {
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
                        } as unknown as SendResultT;
                    }

                    return await handleTaskResult();
                };

                return await handleTaskResult();
            });

            this.setRequestHandler('tasks/list', async (request, extra) => {
                try {
                    const { tasks, nextCursor } = await this._taskStore!.listTasks(request.params?.cursor, extra.sessionId);
                    return {
                        tasks,
                        nextCursor,
                        _meta: {}
                    } as unknown as SendResultT;
                } catch (error) {
                    throw new ProtocolError(
                        ProtocolErrorCode.InvalidParams,
                        `Failed to list tasks: ${error instanceof Error ? error.message : String(error)}`
                    );
                }
            });

            this.setRequestHandler('tasks/cancel', async (request, extra) => {
                try {
                    // Get the current task to check if it's in a terminal state, in case the implementation is not atomic
                    const task = await this._taskStore!.getTask(request.params.taskId, extra.sessionId);

                    if (!task) {
                        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Task not found: ${request.params.taskId}`);
                    }

                    // Reject cancellation of terminal tasks
                    if (isTerminal(task.status)) {
                        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Cannot cancel task in terminal status: ${task.status}`);
                    }

                    await this._taskStore!.updateTaskStatus(
                        request.params.taskId,
                        'cancelled',
                        'Client cancelled task execution.',
                        extra.sessionId
                    );

                    this._clearTaskQueue(request.params.taskId);

                    const cancelledTask = await this._taskStore!.getTask(request.params.taskId, extra.sessionId);
                    if (!cancelledTask) {
                        // Task was deleted during cancellation (e.g., cleanup happened)
                        throw new ProtocolError(
                            ProtocolErrorCode.InvalidParams,
                            `Task not found after cancellation: ${request.params.taskId}`
                        );
                    }

                    return {
                        _meta: {},
                        ...cancelledTask
                    } as unknown as SendResultT;
                } catch (error) {
                    // Re-throw ProtocolError as-is
                    if (error instanceof ProtocolError) {
                        throw error;
                    }
                    throw new ProtocolError(
                        ProtocolErrorCode.InvalidRequest,
                        `Failed to cancel task: ${error instanceof Error ? error.message : String(error)}`
                    );
                }
            });
        }
    }

    private async _oncancel(notification: CancelledNotification): Promise<void> {
        if (!notification.params.requestId) {
            return;
        }
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
            throw new SdkError(SdkErrorCode.RequestTimeout, 'Maximum total timeout exceeded', {
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
            if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
                this._onresponse(message);
            } else if (isJSONRPCRequest(message)) {
                this._onrequest(message, extra);
            } else if (isJSONRPCNotification(message)) {
                this._onnotification(message);
            } else {
                this._onerror(new Error(`Unknown message type: ${JSON.stringify(message)}`));
            }
        };

        // Pass supported protocol versions to transport for header validation
        transport.setSupportedProtocolVersions?.(this._supportedProtocolVersions);

        await this._transport.start();
    }

    private _onclose(): void {
        const responseHandlers = this._responseHandlers;
        this._responseHandlers = new Map();
        this._progressHandlers.clear();
        this._taskProgressTokens.clear();
        this._pendingDebouncedNotifications.clear();

        const error = new SdkError(SdkErrorCode.ConnectionClosed, 'Connection closed');

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

        // Extract taskId from request metadata if present (needed early for method not found case)
        const relatedTaskId = request.params?._meta?.[RELATED_TASK_META_KEY]?.taskId;

        if (handler === undefined) {
            const errorResponse: JSONRPCErrorResponse = {
                jsonrpc: '2.0',
                id: request.id,
                error: {
                    code: ProtocolErrorCode.MethodNotFound,
                    message: 'Method not found'
                }
            };

            // Queue or send the error response based on whether this is a task-related request
            if (relatedTaskId && this._taskMessageQueue) {
                this._enqueueTaskMessage(
                    relatedTaskId,
                    {
                        type: 'error',
                        message: errorResponse,
                        timestamp: Date.now()
                    },
                    capturedTransport?.sessionId
                ).catch(error => this._onerror(new Error(`Failed to enqueue error response: ${error}`)));
            } else {
                capturedTransport
                    ?.send(errorResponse)
                    .catch(error => this._onerror(new Error(`Failed to send an error response: ${error}`)));
            }
            return;
        }

        const abortController = new AbortController();
        this._requestHandlerAbortControllers.set(request.id, abortController);

        const taskCreationParams = isTaskAugmentedRequestParams(request.params) ? request.params.task : undefined;
        const taskStore = this._taskStore ? this.requestTaskStore(request, capturedTransport?.sessionId) : undefined;

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

                // Set task status to input_required when sending a request within a task context
                // Use the taskId from options (explicit) or fall back to relatedTaskId (inherited)
                const effectiveTaskId = requestOptions.relatedTask?.taskId ?? relatedTaskId;
                if (effectiveTaskId && taskStore) {
                    await taskStore.updateTaskStatus(effectiveTaskId, 'input_required');
                }

                return await this.request(r, resultSchema, requestOptions);
            },
            authInfo: extra?.authInfo,
            requestId: request.id,
            requestInfo: extra?.requestInfo,
            taskId: relatedTaskId,
            taskStore: taskStore,
            taskRequestedTtl: taskCreationParams?.ttl,
            closeSSEStream: extra?.closeSSEStream,
            closeStandaloneSSEStream: extra?.closeStandaloneSSEStream
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

                    const response: JSONRPCResponse = {
                        result,
                        jsonrpc: '2.0',
                        id: request.id
                    };

                    // Queue or send the response based on whether this is a task-related request
                    await (relatedTaskId && this._taskMessageQueue
                        ? this._enqueueTaskMessage(
                              relatedTaskId,
                              {
                                  type: 'response',
                                  message: response,
                                  timestamp: Date.now()
                              },
                              capturedTransport?.sessionId
                          )
                        : capturedTransport?.send(response));
                },
                async error => {
                    if (abortController.signal.aborted) {
                        // Request was cancelled
                        return;
                    }

                    const errorResponse: JSONRPCErrorResponse = {
                        jsonrpc: '2.0',
                        id: request.id,
                        error: {
                            code: Number.isSafeInteger(error['code']) ? error['code'] : ProtocolErrorCode.InternalError,
                            message: error.message ?? 'Internal error',
                            ...(error['data'] !== undefined && { data: error['data'] })
                        }
                    };

                    // Queue or send the error response based on whether this is a task-related request
                    await (relatedTaskId && this._taskMessageQueue
                        ? this._enqueueTaskMessage(
                              relatedTaskId,
                              {
                                  type: 'error',
                                  message: errorResponse,
                                  timestamp: Date.now()
                              },
                              capturedTransport?.sessionId
                          )
                        : capturedTransport?.send(errorResponse));
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

    private _onresponse(response: JSONRPCResponse | JSONRPCErrorResponse): void {
        const messageId = Number(response.id);

        // Check if this is a response to a queued request
        const resolver = this._requestResolvers.get(messageId);
        if (resolver) {
            this._requestResolvers.delete(messageId);
            if (isJSONRPCResultResponse(response)) {
                resolver(response);
            } else {
                const error = new ProtocolError(response.error.code, response.error.message, response.error.data);
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
        if (isJSONRPCResultResponse(response) && response.result && typeof response.result === 'object') {
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

        if (isJSONRPCResultResponse(response)) {
            handler(response);
        } else {
            const error = ProtocolError.fromError(response.error.code, response.error.message, response.error.data);
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
     *
     * @experimental Use `client.experimental.tasks.requestStream()` to access this method.
     */
    protected async *requestStream<T extends AnyObjectSchema>(
        request: SendRequestT,
        resultSchema: T,
        options?: RequestOptions
    ): AsyncGenerator<ResponseMessage<SchemaOutput<T>>, void, void> {
        const { task } = options ?? {};

        // For non-task requests, just yield the result
        if (!task) {
            try {
                const result = await this.request(request, resultSchema, options);
                yield { type: 'result', result };
            } catch (error) {
                yield {
                    type: 'error',
                    error: error instanceof Error ? error : new Error(String(error))
                };
            }
            return;
        }

        // For task-augmented requests, we need to poll for status
        // First, make the request to create the task
        let taskId: string | undefined;
        try {
            // Send the request and get the CreateTaskResult
            const createResult = await this.request(request, CreateTaskResultSchema, options);

            // Extract taskId from the result
            if (createResult.task) {
                taskId = createResult.task.taskId;
                yield { type: 'taskCreated', task: createResult.task };
            } else {
                throw new ProtocolError(ProtocolErrorCode.InternalError, 'Task creation did not return a task');
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
                                error: new ProtocolError(ProtocolErrorCode.InternalError, `Task ${taskId} failed`)
                            };

                            break;
                        }
                        case 'cancelled': {
                            yield {
                                type: 'error',
                                error: new ProtocolError(ProtocolErrorCode.InternalError, `Task ${taskId} was cancelled`)
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
                const pollInterval = task.pollInterval ?? this._options?.defaultTaskPollInterval ?? 1000;
                await new Promise(resolve => setTimeout(resolve, pollInterval));

                // Check if cancelled
                options?.signal?.throwIfAborted();
            }
        } catch (error) {
            yield {
                type: 'error',
                error: error instanceof Error ? error : new Error(String(error))
            };
        }
    }

    /**
     * Sends a request and waits for a response.
     *
     * Do not use this method to emit notifications! Use notification() instead.
     */
    request<T extends AnySchema>(request: SendRequestT, resultSchema: T, options?: RequestOptions): Promise<SchemaOutput<T>> {
        const { relatedRequestId, resumptionToken, onresumptiontoken, task, relatedTask } = options ?? {};

        // Send the request
        return new Promise<SchemaOutput<T>>((resolve, reject) => {
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
                } catch (error) {
                    earlyReject(error);
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
                        ...request.params?._meta,
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
                        ...jsonrpcRequest.params?._meta,
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

                // Wrap the reason in an SdkError if it isn't already
                const error = reason instanceof SdkError ? reason : new SdkError(SdkErrorCode.RequestTimeout, String(reason));
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
                    const parseResult = parseSchema(resultSchema, response.result);
                    if (parseResult.success) {
                        resolve(parseResult.data as SchemaOutput<T>);
                    } else {
                        reject(parseResult.error);
                    }
                } catch (error) {
                    reject(error);
                }
            });

            options?.signal?.addEventListener('abort', () => {
                cancel(options?.signal?.reason);
            });

            const timeout = options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC;
            const timeoutHandler = () => cancel(new SdkError(SdkErrorCode.RequestTimeout, 'Request timed out', { timeout }));

            this._setupTimeout(messageId, timeout, options?.maxTotalTimeout, timeoutHandler, options?.resetTimeoutOnProgress ?? false);

            // Queue request if related to a task
            const relatedTaskId = relatedTask?.taskId;
            if (relatedTaskId) {
                // Store the response resolver for this request so responses can be routed back
                const responseResolver = (response: JSONRPCResultResponse | Error) => {
                    const handler = this._responseHandlers.get(messageId);
                    if (handler) {
                        handler(response);
                    } else {
                        // Log error when resolver is missing, but don't fail
                        this._onerror(new Error(`Response handler missing for side-channeled request ${messageId}`));
                    }
                };
                this._requestResolvers.set(messageId, responseResolver);

                this._enqueueTaskMessage(relatedTaskId, {
                    type: 'request',
                    message: jsonrpcRequest,
                    timestamp: Date.now()
                }).catch(error => {
                    this._cleanupTimeout(messageId);
                    reject(error);
                });

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
     *
     * @experimental Use `client.experimental.tasks.getTask()` to access this method.
     */
    protected async getTask(params: GetTaskRequest['params'], options?: RequestOptions): Promise<GetTaskResult> {
        // @ts-expect-error SendRequestT cannot directly contain GetTaskRequest, but we ensure all type instantiations contain it anyways
        return this.request({ method: 'tasks/get', params }, GetTaskResultSchema, options);
    }

    /**
     * Retrieves the result of a completed task.
     *
     * @experimental Use `client.experimental.tasks.getTaskResult()` to access this method.
     */
    protected async getTaskResult<T extends AnySchema>(
        params: GetTaskPayloadRequest['params'],
        resultSchema: T,
        options?: RequestOptions
    ): Promise<SchemaOutput<T>> {
        // @ts-expect-error SendRequestT cannot directly contain GetTaskPayloadRequest, but we ensure all type instantiations contain it anyways
        return this.request({ method: 'tasks/result', params }, resultSchema, options);
    }

    /**
     * Lists tasks, optionally starting from a pagination cursor.
     *
     * @experimental Use `client.experimental.tasks.listTasks()` to access this method.
     */
    protected async listTasks(params?: { cursor?: string }, options?: RequestOptions): Promise<SchemaOutput<typeof ListTasksResultSchema>> {
        // @ts-expect-error SendRequestT cannot directly contain ListTasksRequest, but we ensure all type instantiations contain it anyways
        return this.request({ method: 'tasks/list', params }, ListTasksResultSchema, options);
    }

    /**
     * Cancels a specific task.
     *
     * @experimental Use `client.experimental.tasks.cancelTask()` to access this method.
     */
    protected async cancelTask(params: { taskId: string }, options?: RequestOptions): Promise<SchemaOutput<typeof CancelTaskResultSchema>> {
        // @ts-expect-error SendRequestT cannot directly contain CancelTaskRequest, but we ensure all type instantiations contain it anyways
        return this.request({ method: 'tasks/cancel', params }, CancelTaskResultSchema, options);
    }

    /**
     * Emits a notification, which is a one-way message that does not expect a response.
     */
    async notification(notification: SendNotificationT, options?: NotificationOptions): Promise<void> {
        if (!this._transport) {
            throw new SdkError(SdkErrorCode.NotConnected, 'Not connected');
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
                        ...notification.params?._meta,
                        [RELATED_TASK_META_KEY]: options.relatedTask
                    }
                }
            };

            await this._enqueueTaskMessage(relatedTaskId, {
                type: 'notification',
                message: jsonrpcNotification,
                timestamp: Date.now()
            });

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
                                ...jsonrpcNotification.params?._meta,
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
                        ...jsonrpcNotification.params?._meta,
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
    setRequestHandler<M extends RequestMethod>(
        method: M,
        handler: (
            request: RequestTypeMap[M],
            extra: RequestHandlerExtra<SendRequestT, SendNotificationT>
        ) => SendResultT | Promise<SendResultT>
    ): void {
        this.assertRequestHandlerCapability(method);
        const schema = getRequestSchema(method);

        this._requestHandlers.set(method, (request, extra) => {
            const parsed = schema.parse(request);
            return Promise.resolve(handler(parsed, extra));
        });
    }

    /**
     * Removes the request handler for the given method.
     */
    removeRequestHandler(method: RequestMethod): void {
        this._requestHandlers.delete(method);
    }

    /**
     * Asserts that a request handler has not already been set for the given method, in preparation for a new one being automatically installed.
     */
    assertCanSetRequestHandler(method: RequestMethod): void {
        if (this._requestHandlers.has(method)) {
            throw new Error(`A request handler for ${method} already exists, which would be overridden`);
        }
    }

    /**
     * Registers a handler to invoke when this protocol object receives a notification with the given method.
     *
     * Note that this will replace any previous notification handler for the same method.
     */
    setNotificationHandler<M extends NotificationMethod>(
        method: M,
        handler: (notification: NotificationTypeMap[M]) => void | Promise<void>
    ): void {
        const schema = getNotificationSchema(method);

        this._notificationHandlers.set(method, notification => {
            const parsed = schema.parse(notification);
            return Promise.resolve(handler(parsed));
        });
    }

    /**
     * Removes the notification handler for the given method.
     */
    removeNotificationHandler(method: NotificationMethod): void {
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
     * @param sessionId Optional session ID for binding the operation to a specific session
     * @throws Error if taskStore is not configured or if enqueue fails (e.g., queue overflow)
     *
     * Note: If enqueue fails, it's the TaskMessageQueue implementation's responsibility to handle
     * the error appropriately (e.g., by failing the task, logging, etc.). The Protocol layer
     * simply propagates the error.
     */
    private async _enqueueTaskMessage(taskId: string, message: QueuedMessage, sessionId?: string): Promise<void> {
        // Task message queues are only used when taskStore is configured
        if (!this._taskStore || !this._taskMessageQueue) {
            throw new Error('Cannot enqueue task message: taskStore and taskMessageQueue are not configured');
        }

        const maxQueueSize = this._options?.maxTaskQueueSize;
        await this._taskMessageQueue.enqueue(taskId, message, sessionId, maxQueueSize);
    }

    /**
     * Clears the message queue for a task and rejects any pending request resolvers.
     * @param taskId The task ID whose queue should be cleared
     * @param sessionId Optional session ID for binding the operation to a specific session
     */
    private async _clearTaskQueue(taskId: string, sessionId?: string): Promise<void> {
        if (this._taskMessageQueue) {
            // Reject any pending request resolvers
            const messages = await this._taskMessageQueue.dequeueAll(taskId, sessionId);
            for (const message of messages) {
                if (message.type === 'request' && isJSONRPCRequest(message.message)) {
                    // Extract request ID from the message
                    const requestId = message.message.id as RequestId;
                    const resolver = this._requestResolvers.get(requestId);
                    if (resolver) {
                        resolver(new ProtocolError(ProtocolErrorCode.InternalError, 'Task cancelled or completed'));
                        this._requestResolvers.delete(requestId);
                    } else {
                        // Log error when resolver is missing during cleanup for better observability
                        this._onerror(new Error(`Resolver missing for request ${requestId} during task ${taskId} cleanup`));
                    }
                }
            }
        }
    }

    /**
     * Waits for a task update (new messages or status change) with abort signal support.
     * Uses polling to check for updates at the task's configured poll interval.
     * @param taskId The task ID to wait for
     * @param signal Abort signal to cancel the wait
     * @returns Promise that resolves when an update occurs or rejects if aborted
     */
    private async _waitForTaskUpdate(taskId: string, signal: AbortSignal): Promise<void> {
        // Get the task's poll interval, falling back to default
        let interval = this._options?.defaultTaskPollInterval ?? 1000;
        try {
            const task = await this._taskStore?.getTask(taskId);
            if (task?.pollInterval) {
                interval = task.pollInterval;
            }
        } catch {
            // Use default interval if task lookup fails
        }

        return new Promise((resolve, reject) => {
            if (signal.aborted) {
                reject(new ProtocolError(ProtocolErrorCode.InvalidRequest, 'Request cancelled'));
                return;
            }

            // Wait for the poll interval, then resolve so caller can check for updates
            const timeoutId = setTimeout(resolve, interval);

            // Clean up timeout and reject if aborted
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
                    throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Failed to retrieve task: Task not found');
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
                        params: task
                    });
                    await this.notification(notification as SendNotificationT);

                    if (isTerminal(task.status)) {
                        this._cleanupTaskProgressHandler(taskId);
                        // Don't clear queue here - it will be cleared after delivery via tasks/result
                    }
                }
            },
            getTaskResult: taskId => {
                return taskStore.getTaskResult(taskId, sessionId);
            },
            updateTaskStatus: async (taskId, status, statusMessage) => {
                // Check if task exists
                const task = await taskStore.getTask(taskId, sessionId);
                if (!task) {
                    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Task "${taskId}" not found - it may have been cleaned up`);
                }

                // Don't allow transitions from terminal states
                if (isTerminal(task.status)) {
                    throw new ProtocolError(
                        ProtocolErrorCode.InvalidParams,
                        `Cannot update task "${taskId}" from terminal status "${task.status}" to "${status}". Terminal states (completed, failed, cancelled) cannot transition to other states.`
                    );
                }

                await taskStore.updateTaskStatus(taskId, status, statusMessage, sessionId);

                // Get updated task state and send notification
                const updatedTask = await taskStore.getTask(taskId, sessionId);
                if (updatedTask) {
                    const notification: TaskStatusNotification = TaskStatusNotificationSchema.parse({
                        method: 'notifications/tasks/status',
                        params: updatedTask
                    });
                    await this.notification(notification as SendNotificationT);

                    if (isTerminal(updatedTask.status)) {
                        this._cleanupTaskProgressHandler(taskId);
                        // Don't clear queue here - it will be cleared after delivery via tasks/result
                    }
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
        result[k] =
            isPlainObject(baseValue) && isPlainObject(addValue)
                ? ({ ...(baseValue as Record<string, unknown>), ...(addValue as Record<string, unknown>) } as T[typeof k])
                : (addValue as T[typeof k]);
    }
    return result;
}
