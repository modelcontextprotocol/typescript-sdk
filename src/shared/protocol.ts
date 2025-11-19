import { ZodLiteral, ZodObject, ZodType, z } from 'zod';
import {
    CancelledNotificationSchema,
    ClientCapabilities,
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
import { PendingRequest } from './request.js';
import { isTerminal, TaskStore } from './task.js';

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
     * Stores the result of a completed task.
     *
     * @param taskId - The task identifier
     * @param result - The result to store
     */
    storeTaskResult(taskId: string, result: Result): Promise<void>;

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
export type RequestHandlerExtra<
    SendRequestT extends Request,
    SendNotificationT extends Notification,
    SendResultT extends Result = Result
> = {
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
    sendRequest: <U extends ZodType<SendResultT>>(
        request: SendRequestT,
        resultSchema: U,
        options?: TaskRequestOptions
    ) => Promise<z.infer<U>>;
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
        (request: JSONRPCRequest, extra: RequestHandlerExtra<SendRequestT, SendNotificationT, SendResultT>) => Promise<SendResultT>
    > = new Map();
    private _requestHandlerAbortControllers: Map<RequestId, AbortController> = new Map();
    private _notificationHandlers: Map<string, (notification: JSONRPCNotification) => Promise<void>> = new Map();
    private _responseHandlers: Map<number, (response: JSONRPCResponse | Error) => void> = new Map();
    private _progressHandlers: Map<number, ProgressCallback> = new Map();
    private _timeoutInfo: Map<number, TimeoutInfo> = new Map();
    private _pendingDebouncedNotifications = new Set<string>();

    private _taskStore?: TaskStore;

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
    fallbackRequestHandler?: (
        request: JSONRPCRequest,
        extra: RequestHandlerExtra<SendRequestT, SendNotificationT, SendResultT>
    ) => Promise<SendResultT>;

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
                // as the taskId parameter is the source of truth (Requirement 6.3)
                // @ts-expect-error SendResultT cannot contain GetTaskResult, but we include it in our derived types everywhere else
                return {
                    ...task
                } as SendResultT;
            });

            this.setRequestHandler(GetTaskPayloadRequestSchema, async (request, extra) => {
                // Helper function to wait with abort signal support
                const waitWithAbort = (ms: number, signal: AbortSignal): Promise<void> => {
                    return new Promise((resolve, reject) => {
                        if (signal.aborted) {
                            reject(new McpError(ErrorCode.InvalidRequest, 'Request cancelled while waiting for task completion'));
                            return;
                        }

                        const timeoutId = setTimeout(() => {
                            signal.removeEventListener('abort', abortHandler);
                            resolve();
                        }, ms);

                        const abortHandler = () => {
                            clearTimeout(timeoutId);
                            reject(new McpError(ErrorCode.InvalidRequest, 'Request cancelled while waiting for task completion'));
                        };

                        signal.addEventListener('abort', abortHandler, { once: true });
                    });
                };

                const task = await this._taskStore!.getTask(request.params.taskId, extra.sessionId);
                if (!task) {
                    throw new McpError(ErrorCode.InvalidParams, `Task not found: ${request.params.taskId}`);
                }

                // If task is not in a terminal state, block until it reaches one
                if (!isTerminal(task.status)) {
                    // Poll for task completion
                    let currentTask = task;
                    while (!isTerminal(currentTask.status)) {
                        // Wait for the poll interval before checking again
                        await waitWithAbort(currentTask.pollInterval ?? 5000, extra.signal);

                        // Get updated task status
                        const updatedTask = await this._taskStore!.getTask(request.params.taskId, extra.sessionId);
                        if (!updatedTask) {
                            throw new McpError(ErrorCode.InvalidParams, `Task not found: ${request.params.taskId}`);
                        }
                        currentTask = updatedTask;
                    }
                }

                // Task is now in a terminal state (completed, failed, or cancelled)
                // Retrieve and return the result
                const result = await this._taskStore!.getTaskResult(request.params.taskId, extra.sessionId);
                return {
                    ...result,
                    _meta: {
                        ...result._meta,
                        [RELATED_TASK_META_KEY]: {
                            taskId: request.params.taskId
                        }
                    }
                } as SendResultT;
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

        // Extract taskId from request metadata if present (Requirement 6.1)
        const relatedTaskId = request.params?._meta?.[RELATED_TASK_META_KEY]?.taskId;

        const fullExtra: RequestHandlerExtra<SendRequestT, SendNotificationT, SendResultT> = {
            signal: abortController.signal,
            sessionId: capturedTransport?.sessionId,
            _meta: request.params?._meta,
            sendNotification: async notification => {
                // Include related-task metadata if this request is part of a task (Requirement 6.1)
                const notificationOptions: NotificationOptions = { relatedRequestId: request.id };
                if (relatedTaskId) {
                    notificationOptions.relatedTask = { taskId: relatedTaskId };
                }
                await this.notification(notification, notificationOptions);
            },
            sendRequest: async (r, resultSchema, options?) => {
                // Include related-task metadata if this request is part of a task (Requirement 6.1)
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
        const handler = this._responseHandlers.get(messageId);
        if (handler === undefined) {
            this._onerror(new Error(`Received a response for an unknown message ID: ${JSON.stringify(response)}`));
            return;
        }

        this._responseHandlers.delete(messageId);
        this._progressHandlers.delete(messageId);
        this._cleanupTimeout(messageId);

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
     * Begins a request and returns a PendingRequest object for granular control over task-based execution.
     *
     * Do not use this method to emit notifications! Use notification() instead.
     */
    beginRequest<T extends ZodType<SendResultT>>(
        request: SendRequestT,
        resultSchema: T,
        options?: RequestOptions
    ): PendingRequest<SendRequestT, SendNotificationT, SendResultT> {
        const { relatedRequestId, resumptionToken, onresumptiontoken, task, relatedTask } = options ?? {};

        // Send the request
        const result = new Promise<z.infer<T>>((resolve, reject) => {
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

                reject(reason);
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

            this._transport.send(jsonrpcRequest, { relatedRequestId, resumptionToken, onresumptiontoken }).catch(error => {
                this._cleanupTimeout(messageId);
                reject(error);
            });
        });

        return new PendingRequest(this, result, resultSchema, undefined, this._options?.defaultTaskPollInterval);
    }

    /**
     * Sends a request and waits for a response.
     *
     * Do not use this method to emit notifications! Use notification() instead.
     */
    request<T extends ZodType<SendResultT>>(request: SendRequestT, resultSchema: T, options?: RequestOptions): Promise<z.infer<T>> {
        return this.beginRequest(request, resultSchema, options).result();
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
    async getTaskResult<T extends ZodType<SendResultT>>(
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
        handler: (
            request: z.infer<T>,
            extra: RequestHandlerExtra<SendRequestT, SendNotificationT, SendResultT>
        ) => SendResultT | Promise<SendResultT>
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
            storeTaskResult: async (taskId, result) => {
                await taskStore.storeTaskResult(taskId, result, sessionId);

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
                }
            },
            getTaskResult: taskId => {
                return taskStore.getTaskResult(taskId, sessionId);
            },
            updateTaskStatus: async (taskId, status, statusMessage) => {
                try {
                    // Check the current task status to avoid overwriting terminal states
                    // as a safeguard for when the TaskStore implementation doesn't try
                    // to avoid this.
                    const task = await taskStore.getTask(taskId, sessionId);
                    if (!task) {
                        return;
                    }

                    if (isTerminal(task.status)) {
                        this._onerror(
                            new Error(`Failed to update status of task "${taskId}" from terminal status "${task.status}" to "${status}"`)
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
