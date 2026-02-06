import { SdkError, SdkErrorCode } from '../errors/sdkErrors.js';
import type {
    AuthInfo,
    CancelledNotification,
    ClientCapabilities,
    CreateMessageRequest,
    CreateMessageResult,
    CreateMessageResultWithTools,
    ElicitRequestFormParams,
    ElicitRequestURLParams,
    ElicitResult,
    JSONRPCErrorResponse,
    JSONRPCNotification,
    JSONRPCRequest,
    JSONRPCResponse,
    JSONRPCResultResponse,
    LoggingLevel,
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
    TaskCreationParams
} from '../types/types.js';
import {
    getNotificationSchema,
    getRequestSchema,
    isJSONRPCErrorResponse,
    isJSONRPCNotification,
    isJSONRPCRequest,
    isJSONRPCResultResponse,
    ProtocolError,
    ProtocolErrorCode,
    SUPPORTED_PROTOCOL_VERSIONS
} from '../types/types.js';
import type { AnySchema, SchemaOutput } from '../util/schema.js';
import { parseSchema } from '../util/schema.js';
import type { TaskContext, TaskManagerHost, TaskManagerOptions, TaskRequestOptions } from './taskManager.js';
import { NullTaskManager, TaskManager } from './taskManager.js';
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
     * Task manager options. If a taskStore is provided, enables task-related request handlers
     * and provides task storage capabilities to request handlers.
     */
    tasks?: TaskManagerOptions;
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
 * Base context provided to all request handlers.
 */
export type BaseContext = {
    /**
     * The session ID from the transport, if available.
     */
    sessionId?: string;

    /**
     * Information about the MCP request being handled.
     */
    mcpReq: {
        /**
         * The JSON-RPC ID of the request being handled.
         */
        id: RequestId;

        /**
         * The method name of the request (e.g., 'tools/call', 'ping').
         */
        method: string;

        /**
         * Metadata from the original request.
         */
        _meta?: RequestMeta;

        /**
         * An abort signal used to communicate if the request was cancelled from the sender's side.
         */
        signal: AbortSignal;

        /**
         * Sends a request that relates to the current request being handled.
         *
         * This is used by certain transports to correctly associate related messages.
         */
        send: <U extends AnySchema>(request: Request, resultSchema: U, options?: TaskRequestOptions) => Promise<SchemaOutput<U>>;

        /**
         * Sends a notification that relates to the current request being handled.
         *
         * This is used by certain transports to correctly associate related messages.
         */
        notify: (notification: Notification) => Promise<void>;
    };

    /**
     * HTTP transport information, only available when using an HTTP-based transport.
     */
    http?: {
        /**
         * Information about a validated access token, provided to request handlers.
         */
        authInfo?: AuthInfo;
    };

    /**
     * Task context, available when task storage is configured.
     */
    task?: TaskContext;
};

/**
 * Context provided to server-side request handlers, extending BaseContext with server-specific fields.
 */
export type ServerContext = BaseContext & {
    mcpReq: {
        /**
         * Send a log message notification to the client.
         * Respects the client's log level filter set via logging/setLevel.
         */
        log: (level: LoggingLevel, data: unknown, logger?: string) => Promise<void>;

        /**
         * Send an elicitation request to the client, requesting user input.
         */
        elicitInput: (params: ElicitRequestFormParams | ElicitRequestURLParams, options?: RequestOptions) => Promise<ElicitResult>;

        /**
         * Request LLM sampling from the client.
         */
        requestSampling: (
            params: CreateMessageRequest['params'],
            options?: RequestOptions
        ) => Promise<CreateMessageResult | CreateMessageResultWithTools>;
    };

    http?: {
        /**
         * The original HTTP request information.
         */
        req?: RequestInfo;

        /**
         * Closes the SSE stream for this request, triggering client reconnection.
         * Only available when using a StreamableHTTPServerTransport with eventStore configured.
         */
        closeSSE?: () => void;

        /**
         * Closes the standalone GET SSE stream, triggering client reconnection.
         * Only available when using a StreamableHTTPServerTransport with eventStore configured.
         */
        closeStandaloneSSE?: () => void;
    };
};

/**
 * Context provided to client-side request handlers.
 */
export type ClientContext = BaseContext;

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
export abstract class Protocol<ContextT extends BaseContext> {
    private _transport?: Transport;
    private _requestMessageId = 0;
    private _requestHandlers: Map<string, (request: JSONRPCRequest, ctx: ContextT) => Promise<Result>> = new Map();
    private _requestHandlerAbortControllers: Map<RequestId, AbortController> = new Map();
    private _notificationHandlers: Map<string, (notification: JSONRPCNotification) => Promise<void>> = new Map();
    private _responseHandlers: Map<number, (response: JSONRPCResultResponse | Error) => void> = new Map();
    private _progressHandlers: Map<number, ProgressCallback> = new Map();
    private _timeoutInfo: Map<number, TimeoutInfo> = new Map();
    private _pendingDebouncedNotifications = new Set<string>();

    private _taskManager: TaskManager;

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
    fallbackRequestHandler?: (request: JSONRPCRequest, ctx: ContextT) => Promise<Result>;

    /**
     * A handler to invoke for any notification types that do not have their own handler installed.
     */
    fallbackNotificationHandler?: (notification: Notification) => Promise<void>;

    constructor(private _options?: ProtocolOptions) {
        this._supportedProtocolVersions = _options?.supportedProtocolVersions ?? SUPPORTED_PROTOCOL_VERSIONS;

        // Create TaskManager from protocol options
        this._taskManager = _options?.tasks?.taskStore ? new TaskManager(_options.tasks) : new NullTaskManager();

        // Bind TaskManager to this Protocol as its host
        const host: TaskManagerHost = {
            request: (request, resultSchema, options) => this.request(request, resultSchema, options),
            notification: (notification, options) => this.notification(notification, options),
            reportError: error => this._onerror(error),
            removeProgressHandler: token => this._progressHandlers.delete(token),
            registerHandler: (method, handler) => {
                this._requestHandlers.set(method, (request, ctx) => handler(request, ctx));
            },
            sendOnResponseStream: async (message, relatedRequestId) => {
                await this._transport?.send(message, { relatedRequestId });
            }
        };
        this._taskManager.bind(host);

        this.setNotificationHandler('notifications/cancelled', notification => {
            this._oncancel(notification);
        });

        this.setNotificationHandler('notifications/progress', notification => {
            this._onprogress(notification);
        });

        this.setRequestHandler(
            'ping',
            // Automatic pong by default.
            _request => ({}) as Result
        );
    }

    /**
     * Access the TaskManager for task orchestration.
     * Always available; returns a NullTaskManager when no task store is configured.
     * The NullTaskManager supports outbound methods (requestStream, getTask, etc.)
     * but does not handle inbound task requests.
     */
    get tasks(): TaskManager {
        return this._taskManager;
    }

    /**
     * Builds the context object for request handlers. Subclasses must override
     * to return the appropriate context type (e.g., ServerContext adds requestInfo).
     */
    protected abstract buildContext(ctx: BaseContext, transportInfo?: MessageExtraInfo): ContextT;

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
        this._taskManager.onClose();
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

        // Delegate task context extraction to TaskManager
        const taskResult = this._taskManager.processInboundRequest(request, {
            sessionId: capturedTransport?.sessionId,
            sendNotification: (notification, options?) => this.notification(notification, { ...options, relatedRequestId: request.id }),
            sendRequest: (r, resultSchema, options?) => this.request(r, resultSchema, { ...options, relatedRequestId: request.id })
        });

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
            taskResult
                .routeResponse(errorResponse)
                .then(routed => {
                    if (!routed) {
                        capturedTransport
                            ?.send(errorResponse)
                            .catch(error => this._onerror(new Error(`Failed to send an error response: ${error}`)));
                    }
                })
                .catch(error => this._onerror(new Error(`Failed to enqueue error response: ${error}`)));
            return;
        }

        const abortController = new AbortController();
        this._requestHandlerAbortControllers.set(request.id, abortController);

        const baseCtx: BaseContext = {
            sessionId: capturedTransport?.sessionId,
            mcpReq: {
                id: request.id,
                method: request.method,
                _meta: request.params?._meta,
                signal: abortController.signal,
                send: taskResult.sendRequest,
                notify: taskResult.sendNotification
            },
            http: extra?.authInfo ? { authInfo: extra.authInfo } : undefined,
            task: taskResult.taskContext
        };
        const ctx = this.buildContext(baseCtx, extra);

        // Starting with Promise.resolve() puts any synchronous errors into the monad as well.
        Promise.resolve()
            .then(() => {
                // If this request asked for task creation, check capability first
                if (taskResult.hasTaskCreationParams) {
                    this.assertTaskHandlerCapability(request.method);
                }
            })
            .then(() => handler(request, ctx))
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
                    const routed = await taskResult.routeResponse(response);
                    if (!routed) {
                        await capturedTransport?.send(response);
                    }
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
                    const routed = await taskResult.routeResponse(errorResponse);
                    if (!routed) {
                        await capturedTransport?.send(errorResponse);
                    }
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

        // Delegate to TaskManager for task-related response handling
        const { consumed, preserveProgress } = this._taskManager.processInboundResponse(response, messageId);
        if (consumed) {
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
        if (!preserveProgress) {
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
    protected abstract assertCapabilityForMethod(method: RequestMethod): void;

    /**
     * A method to check if a notification is supported by the local side, for the given method to be sent.
     *
     * This should be implemented by subclasses.
     */
    protected abstract assertNotificationCapability(method: NotificationMethod): void;

    /**
     * A method to check if a request handler is supported by the local side, for the given method to be handled.
     *
     * This should be implemented by subclasses.
     */
    protected abstract assertRequestHandlerCapability(method: string): void;

    /**
     * A method to check if task creation is supported for a given request method.
     *
     * This should be implemented by subclasses.
     */
    protected abstract assertTaskCapability(method: string): void;

    /**
     * A method to check if task handling is supported for a given request method.
     *
     * This should be implemented by subclasses.
     */
    protected abstract assertTaskHandlerCapability(method: string): void;

    /**
     * Sends a request and waits for a response.
     *
     * Do not use this method to emit notifications! Use notification() instead.
     */
    request<T extends AnySchema>(request: Request, resultSchema: T, options?: RequestOptions): Promise<SchemaOutput<T>> {
        const { relatedRequestId, resumptionToken, onresumptiontoken, task } = options ?? {};

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
                    this.assertCapabilityForMethod(request.method as RequestMethod);

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

            // Delegate task augmentation and routing to TaskManager
            const responseHandler = (response: JSONRPCResultResponse | Error) => {
                const handler = this._responseHandlers.get(messageId);
                if (handler) {
                    handler(response);
                } else {
                    this._onerror(new Error(`Response handler missing for side-channeled request ${messageId}`));
                }
            };

            const { queued } = this._taskManager.processOutboundRequest(jsonrpcRequest, options, messageId, responseHandler, error => {
                this._cleanupTimeout(messageId);
                reject(error);
            });

            if (!queued) {
                // No related task - send through transport normally
                this._transport.send(jsonrpcRequest, { relatedRequestId, resumptionToken, onresumptiontoken }).catch(error => {
                    this._cleanupTimeout(messageId);
                    reject(error);
                });
            }
        });
    }

    /**
     * Emits a notification, which is a one-way message that does not expect a response.
     */
    async notification(notification: Notification, options?: NotificationOptions): Promise<void> {
        if (!this._transport) {
            throw new SdkError(SdkErrorCode.NotConnected, 'Not connected');
        }

        this.assertNotificationCapability(notification.method as NotificationMethod);

        // Delegate task-related notification routing and JSONRPC building to TaskManager
        const { queued, jsonrpcNotification } = await this._taskManager.processOutboundNotification(notification, options);
        if (queued) {
            // Don't send through transport - queued messages are delivered via tasks/result only
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

                // Send the notification, but don't await it here to avoid blocking.
                // Handle potential errors with a .catch().
                this._transport?.send(jsonrpcNotification!, options).catch(error => this._onerror(error));
            });

            // Return immediately.
            return;
        }

        await this._transport.send(jsonrpcNotification!, options);
    }

    /**
     * Registers a handler to invoke when this protocol object receives a request with the given method.
     *
     * Note that this will replace any previous request handler for the same method.
     */
    setRequestHandler<M extends RequestMethod>(
        method: M,
        handler: (request: RequestTypeMap[M], ctx: ContextT) => Result | Promise<Result>
    ): void {
        this.assertRequestHandlerCapability(method);
        const schema = getRequestSchema(method);

        this._requestHandlers.set(method, (request, ctx) => {
            const parsed = schema.parse(request) as RequestTypeMap[M];
            return Promise.resolve(handler(parsed, ctx));
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
