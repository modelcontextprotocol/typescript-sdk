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
    TaskCreatedNotificationSchema,
    TASK_META_KEY,
    GetTaskResult,
    TaskMetadata,
    RelatedTaskMetadata
} from '../types.js';
import { Transport, TransportSendOptions } from './transport.js';
import { AuthInfo } from '../server/auth/types.js';
import { PendingRequest } from './request.js';
import { TaskStore } from './task.js';

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
     * Optional task storage implementation. If provided, the implementation will automatically
     * handle task creation, status tracking, and result storage.
     */
    taskStore?: TaskStore;
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
     * If provided, augments the request with task metadata to enable call-now, fetch-later execution patterns.
     */
    task?: TaskMetadata;

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
    sendRequest: <U extends ZodType<SendResultT>>(request: SendRequestT, resultSchema: U, options?: RequestOptions) => Promise<z.infer<U>>;
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
    private _pendingTaskCreations: Map<string, { resolve: () => void; reject: (reason: Error) => void }> = new Map();
    private _requestIdToTaskId: Map<number, string> = new Map();
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

        this.setNotificationHandler(TaskCreatedNotificationSchema, notification => {
            const taskId = notification.params?._meta?.[RELATED_TASK_META_KEY]?.taskId;
            if (taskId) {
                const resolver = this._pendingTaskCreations.get(taskId);
                if (resolver) {
                    resolver.resolve();
                    this._pendingTaskCreations.delete(taskId);
                }
            }
        });

        this.setRequestHandler(
            PingRequestSchema,
            // Automatic pong by default.
            _request => ({}) as SendResultT
        );

        // Install task handlers if TaskStore is provided
        this._taskStore = _options?.taskStore;
        if (this._taskStore) {
            this.setRequestHandler(GetTaskRequestSchema, async request => {
                const task = await this._taskStore!.getTask(request.params.taskId);
                if (!task) {
                    throw new McpError(ErrorCode.InvalidParams, 'Failed to retrieve task: Task not found');
                }

                // @ts-expect-error SendResultT cannot contain GetTaskResult, but we include it in our derived types everywhere else
                return {
                    ...task,
                    _meta: {
                        [RELATED_TASK_META_KEY]: {
                            taskId: request.params.taskId
                        }
                    }
                } as SendResultT;
            });

            this.setRequestHandler(GetTaskPayloadRequestSchema, async request => {
                const task = await this._taskStore!.getTask(request.params.taskId);
                if (!task) {
                    throw new McpError(ErrorCode.InvalidParams, 'Failed to retrieve task: Task not found');
                }

                if (task.status !== 'completed') {
                    throw new McpError(ErrorCode.InvalidParams, `Cannot retrieve result: Task status is '${task.status}', not 'completed'`);
                }

                const result = await this._taskStore!.getTaskResult(request.params.taskId);
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
        }
    }

    private async _oncancel(notification: z.infer<typeof CancelledNotificationSchema>): Promise<void> {
        // Handle request cancellation
        const controller = this._requestHandlerAbortControllers.get(notification.params.requestId);
        controller?.abort(notification.params.reason);

        // If this request had a task, mark it as cancelled in storage
        const taskId = this._requestIdToTaskId.get(Number(notification.params.requestId));
        if (taskId && this._taskStore) {
            try {
                await this._taskStore.updateTaskStatus(taskId, 'cancelled');
            } catch (error) {
                this._onerror(new Error(`Failed to cancel task ${taskId}: ${error}`));
            }
        }
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

        // Reject all pending task creations
        for (const resolver of this._pendingTaskCreations.values()) {
            resolver.reject(error);
        }
        this._pendingTaskCreations.clear();

        this._requestIdToTaskId.clear();
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

        const taskMetadata = request.params?._meta?.[TASK_META_KEY];
        const fullExtra: RequestHandlerExtra<SendRequestT, SendNotificationT, SendResultT> = {
            signal: abortController.signal,
            sessionId: capturedTransport?.sessionId,
            _meta: request.params?._meta,
            sendNotification: async notification => {
                const relatedTask = taskMetadata ? { taskId: taskMetadata.taskId } : undefined;
                await this.notification(notification, { relatedRequestId: request.id, relatedTask });
            },
            sendRequest: async (r, resultSchema, options?) => {
                const relatedTask = taskMetadata ? { taskId: taskMetadata.taskId } : undefined;
                return await this.request(r, resultSchema, { ...options, relatedRequestId: request.id, relatedTask });
            },
            authInfo: extra?.authInfo,
            requestId: request.id,
            requestInfo: extra?.requestInfo
        };

        // Starting with Promise.resolve() puts any synchronous errors into the monad as well.
        Promise.resolve()
            .then(async () => {
                // If this request asked for task creation, create the task and send notification
                if (taskMetadata && this._taskStore) {
                    const task = await this._taskStore!.getTask(taskMetadata.taskId);
                    if (task) {
                        throw new McpError(ErrorCode.InvalidParams, `Task ID already exists: ${taskMetadata.taskId}`);
                    }

                    try {
                        await this._taskStore.createTask(taskMetadata, request.id, {
                            method: request.method,
                            params: request.params
                        });

                        // Send task created notification
                        await this.notification(
                            {
                                method: 'notifications/tasks/created',
                                params: {
                                    _meta: {
                                        [RELATED_TASK_META_KEY]: {
                                            taskId: taskMetadata.taskId
                                        }
                                    }
                                }
                            } as SendNotificationT,
                            { relatedRequestId: request.id }
                        );
                    } catch (error) {
                        throw new McpError(ErrorCode.InternalError, `Failed to create task: ${taskMetadata.taskId}`);
                    }
                }
            })
            .then(async () => {
                // If this request had a task, mark it as working
                if (taskMetadata && this._taskStore) {
                    try {
                        await this._taskStore.updateTaskStatus(taskMetadata.taskId, 'working');
                    } catch (error) {
                        try {
                            await this._taskStore.updateTaskStatus(taskMetadata.taskId, 'failed', 'Failed to mark task as working');
                        } catch (error) {
                            throw new McpError(ErrorCode.InternalError, `Failed to mark task as working: ${error}`);
                        }
                    }
                }
            })
            .then(() => handler(request, fullExtra))
            .then(
                async result => {
                    if (abortController.signal.aborted) {
                        return;
                    }

                    // Send the response
                    await capturedTransport?.send({
                        result,
                        jsonrpc: '2.0',
                        id: request.id
                    });

                    // Store the result if this was a task-based request
                    if (taskMetadata && this._taskStore) {
                        try {
                            await this._taskStore.storeTaskResult(taskMetadata.taskId, result);
                        } catch (error) {
                            throw new McpError(ErrorCode.InternalError, `Failed to store task result: ${error}`);
                        }
                    }
                },
                error => {
                    if (abortController.signal.aborted) {
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

        // Clean up task tracking if this request had a taskId
        const taskId = this._requestIdToTaskId.get(messageId);
        if (taskId) {
            this._requestIdToTaskId.delete(messageId);
            const resolver = this._pendingTaskCreations.get(taskId);

            // Reject the promise if the task never got created
            resolver?.reject(new Error('Request completed without task creation notification'));
            this._pendingTaskCreations.delete(taskId);
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
        const { taskId, keepAlive } = task ?? {};

        // For tasks, create an advance promise for the creation notification to avoid
        // race conditions with installing this callback.
        const taskCreated = taskId ? this.waitForTaskCreation(taskId) : Promise.resolve();

        // Send the request
        const result = new Promise<z.infer<T>>((resolve, reject) => {
            if (!this._transport) {
                reject(new Error('Not connected'));
                return;
            }

            if (this._options?.enforceStrictCapabilities === true) {
                this.assertCapabilityForMethod(request.method);
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

            // Augment with task metadata if taskId is provided
            if (taskId) {
                this._requestIdToTaskId.set(messageId, taskId);
                jsonrpcRequest.params = {
                    ...jsonrpcRequest.params,
                    _meta: {
                        ...(jsonrpcRequest.params?._meta || {}),
                        [TASK_META_KEY]: {
                            taskId,
                            ...(keepAlive !== undefined ? { keepAlive } : {})
                        }
                    }
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

        return new PendingRequest(this, taskCreated, result, resultSchema, taskId);
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
     * Waits for a task creation notification with the given taskId.
     * Returns a promise that resolves when the notifications/tasks/created notification is received,
     * or rejects if the task is cleaned up (e.g., connection closed or request completed).
     */
    private waitForTaskCreation(taskId: string): Promise<void> {
        return new Promise((resolve, reject) => {
            this._pendingTaskCreations.set(taskId, { resolve, reject });
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
    async getTaskResult<T extends ZodType<SendResultT>>(
        params: GetTaskPayloadRequest['params'],
        resultSchema: T,
        options?: RequestOptions
    ): Promise<z.infer<T>> {
        // @ts-expect-error SendRequestT cannot directly contain GetTaskPayloadRequest, but we ensure all type instantiations contain it anyways
        return this.request({ method: 'tasks/result', params }, resultSchema, options);
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
}

export function mergeCapabilities<T extends ServerCapabilities | ClientCapabilities>(base: T, additional: T): T {
    return Object.entries(additional).reduce(
        (acc, [key, value]) => {
            if (value && typeof value === 'object') {
                acc[key] = acc[key] ? { ...acc[key], ...value } : value;
            } else {
                acc[key] = value;
            }
            return acc;
        },
        { ...base }
    );
}
