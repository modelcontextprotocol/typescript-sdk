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
    RequestMeta,
    RequestMethod,
    RequestTypeMap,
    Result,
    ResultTypeMap,
    ServerCapabilities,
    TaskCreationParams
} from '../types/index.js';
import {
    getNotificationSchema,
    getRequestSchema,
    getResultSchema,
    isJSONRPCErrorResponse,
    isJSONRPCNotification,
    isJSONRPCRequest,
    isJSONRPCResultResponse,
    ProtocolError,
    ProtocolErrorCode,
    SUPPORTED_PROTOCOL_VERSIONS
} from '../types/index.js';
import type { StandardSchemaV1 } from '../util/standardSchema.js';
import { isStandardSchema, validateStandardSchema } from '../util/standardSchema.js';
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
     * used as fallback by server). Passed to transport during {@linkcode Protocol.connect | connect()}.
     *
     * @default {@linkcode SUPPORTED_PROTOCOL_VERSIONS}
     */
    supportedProtocolVersions?: string[];

    /**
     * Whether to restrict emitted requests to only those that the remote side has indicated that they can handle, through their advertised capabilities.
     *
     * Note that this DOES NOT affect checking of _local_ side capabilities, as it is considered a logic error to mis-specify those.
     *
     * Currently this defaults to `false`, for backwards compatibility with SDK versions that did not advertise capabilities correctly. In future, this will default to `true`.
     */
    enforceStrictCapabilities?: boolean;
    /**
     * An array of notification method names that should be automatically debounced.
     * Any notifications with a method in this list will be coalesced if they
     * occur in the same tick of the event loop.
     * e.g., `['notifications/tools/list_changed']`
     */
    debouncedNotificationMethods?: string[];

    /**
     * Runtime configuration for task management.
     * If provided, creates a TaskManager with the given options; otherwise a NullTaskManager is used.
     *
     * Capability assertions are wired automatically from the protocol's
     * `assertTaskCapability()` and `assertTaskHandlerCapability()` methods,
     * so they should NOT be included here.
     */
    tasks?: TaskManagerOptions;
};

/**
 * The default request timeout, in milliseconds.
 */
export const DEFAULT_REQUEST_TIMEOUT_MSEC = 60_000;

/**
 * Options that can be given per request.
 */
export type RequestOptions = {
    /**
     * If set, requests progress notifications from the remote end (if supported). When progress notifications are received, this callback will be invoked.
     *
     * For task-augmented requests: progress notifications continue after {@linkcode CreateTaskResult} is returned and stop automatically when the task reaches a terminal status.
     */
    onprogress?: ProgressCallback;

    /**
     * Can be used to cancel an in-flight request. This will cause an `AbortError` to be raised from {@linkcode Protocol.request | request()}.
     */
    signal?: AbortSignal;

    /**
     * A timeout (in milliseconds) for this request. If exceeded, an {@linkcode SdkError} with code {@linkcode SdkErrorCode.RequestTimeout} will be raised from {@linkcode Protocol.request | request()}.
     *
     * If not specified, {@linkcode DEFAULT_REQUEST_TIMEOUT_MSEC} will be used as the timeout.
     */
    timeout?: number;

    /**
     * If `true`, receiving a progress notification will reset the request timeout.
     * This is useful for long-running operations that send periodic progress updates.
     * Default: `false`
     */
    resetTimeoutOnProgress?: boolean;

    /**
     * Maximum total time (in milliseconds) to wait for a response.
     * If exceeded, an {@linkcode SdkError} with code {@linkcode SdkErrorCode.RequestTimeout} will be raised, regardless of progress notifications.
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
         *
         * For spec methods the result type is inferred from the method name.
         * For custom (non-spec) methods, pass a result schema as the second argument.
         */
        send: {
            <M extends RequestMethod>(
                request: { method: M; params?: Record<string, unknown> },
                options?: TaskRequestOptions
            ): Promise<ResultTypeMap[M]>;
            <T extends StandardSchemaV1>(
                request: Request,
                resultSchema: T,
                options?: TaskRequestOptions
            ): Promise<StandardSchemaV1.InferOutput<T>>;
        };

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
 * Context provided to server-side request handlers, extending {@linkcode BaseContext} with server-specific fields.
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
         * The original HTTP request.
         */
        req?: globalThis.Request;

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
 *
 * `Protocol` is abstract; `Client` and `Server` are the concrete role-specific
 * implementations most code should use.
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
     * This is invoked when {@linkcode Protocol.close | close()} is called as well.
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
        this._taskManager = _options?.tasks ? new TaskManager(_options.tasks) : new NullTaskManager();
        this._bindTaskManager();

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
     */
    get taskManager(): TaskManager {
        return this._taskManager;
    }

    private _bindTaskManager(): void {
        const taskManager = this._taskManager;
        const host: TaskManagerHost = {
            request: (request, resultSchema, options) => this._requestWithSchema(request, resultSchema, options),
            notification: (notification, options) => this.notification(notification, options),
            reportError: error => this._onerror(error),
            removeProgressHandler: token => this._progressHandlers.delete(token),
            registerHandler: (method, handler) => {
                const schema = getRequestSchema(method as RequestMethod);
                this._requestHandlers.set(method, (request, ctx) => {
                    // Validate request params via Zod (strips jsonrpc/id, so we pass original to handler)
                    schema.parse(request);
                    return handler(request, ctx);
                });
            },
            sendOnResponseStream: async (message, relatedRequestId) => {
                await this._transport?.send(message, { relatedRequestId });
            },
            enforceStrictCapabilities: this._options?.enforceStrictCapabilities === true,
            assertTaskCapability: method => this.assertTaskCapability(method),
            assertTaskHandlerCapability: method => this.assertTaskHandlerCapability(method)
        };
        taskManager.bind(host);
    }

    /**
     * Builds the context object for request handlers. Subclasses must override
     * to return the appropriate context type (e.g., ServerContext adds HTTP request info).
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
     * The caller assumes ownership of the {@linkcode Transport}, replacing any callbacks that have already been set, and expects that it is the only user of the {@linkcode Transport} instance going forward.
     */
    async connect(transport: Transport): Promise<void> {
        this._transport = transport;
        const _onclose = this.transport?.onclose;
        this._transport.onclose = () => {
            try {
                _onclose?.();
            } finally {
                this._onclose();
            }
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

        for (const info of this._timeoutInfo.values()) {
            clearTimeout(info.timeoutId);
        }
        this._timeoutInfo.clear();

        const requestHandlerAbortControllers = this._requestHandlerAbortControllers;
        this._requestHandlerAbortControllers = new Map();

        const error = new SdkError(SdkErrorCode.ConnectionClosed, 'Connection closed');

        this._transport = undefined;

        try {
            this.onclose?.();
        } finally {
            for (const handler of responseHandlers.values()) {
                handler(error);
            }

            for (const controller of requestHandlerAbortControllers.values()) {
                controller.abort(error);
            }
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

        // Delegate context extraction to module (if registered)
        const inboundCtx = {
            sessionId: capturedTransport?.sessionId,
            sendNotification: (notification: Notification, options?: NotificationOptions) =>
                this.notification(notification, { ...options, relatedRequestId: request.id }),
            sendRequest: <U extends StandardSchemaV1>(r: Request, resultSchema: U, options?: RequestOptions) =>
                this._requestWithSchema(r, resultSchema, { ...options, relatedRequestId: request.id })
        };

        // Delegate to TaskManager for task context, wrapped send/notify, and response routing
        const taskResult = this._taskManager.processInboundRequest(request, inboundCtx);
        const sendNotification = taskResult.sendNotification;
        const sendRequest = taskResult.sendRequest;
        const taskContext = taskResult.taskContext;
        const routeResponse = taskResult.routeResponse;
        const validators: Array<() => void> = [];
        if (taskResult.validateInbound) validators.push(taskResult.validateInbound);

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
            routeResponse(errorResponse)
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
                // BaseContext.mcpReq.send is declared with two overloads (spec-method-keyed and explicit-schema). Arrow
                // literals can't carry overload signatures, so the inferred single-signature type isn't assignable to
                // that overloaded property type. The cast is sound: this impl dispatches both overload paths via the
                // isStandardSchema guard, and sendRequest validates the result against the resolved schema either way.
                send: ((r: Request, schemaOrOptions?: StandardSchemaV1 | TaskRequestOptions, maybeOptions?: TaskRequestOptions) => {
                    if (isStandardSchema(schemaOrOptions)) {
                        return sendRequest(r, schemaOrOptions, maybeOptions);
                    }
                    const resultSchema = getResultSchema(r.method);
                    if (!resultSchema) {
                        throw new TypeError(
                            `'${r.method}' is not a spec method; pass a result schema as the second argument to ctx.mcpReq.send().`
                        );
                    }
                    return sendRequest(r, resultSchema, schemaOrOptions);
                }) as BaseContext['mcpReq']['send'],
                notify: sendNotification
            },
            http: extra?.authInfo ? { authInfo: extra.authInfo } : undefined,
            task: taskContext
        };
        const ctx = this.buildContext(baseCtx, extra);

        // Starting with Promise.resolve() puts any synchronous errors into the monad as well.
        Promise.resolve()
            .then(() => {
                for (const validate of validators) {
                    validate();
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
                    const routed = await routeResponse(response);
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
                    const routed = await routeResponse(errorResponse);
                    if (!routed) {
                        await capturedTransport?.send(errorResponse);
                    }
                }
            )
            .catch(error => this._onerror(new Error(`Failed to send response: ${error}`)))
            .finally(() => {
                if (this._requestHandlerAbortControllers.get(request.id) === abortController) {
                    this._requestHandlerAbortControllers.delete(request.id);
                }
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
        const taskResult = this._taskManager.processInboundResponse(response, messageId);
        if (taskResult.consumed) return;
        const preserveProgress = taskResult.preserveProgress;

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
    protected abstract assertCapabilityForMethod(method: RequestMethod | string): void;

    /**
     * A method to check if a notification is supported by the local side, for the given method to be sent.
     *
     * This should be implemented by subclasses.
     */
    protected abstract assertNotificationCapability(method: NotificationMethod | string): void;

    /**
     * A method to check if a request handler is supported by the local side, for the given method to be handled.
     *
     * This should be implemented by subclasses.
     */
    protected abstract assertRequestHandlerCapability(method: string): void;

    /**
     * A method to check if the remote side supports task creation for the given method.
     *
     * Called when sending a task-augmented outbound request (only when enforceStrictCapabilities is true).
     * This should be implemented by subclasses.
     */
    protected abstract assertTaskCapability(method: string): void;

    /**
     * A method to check if this side supports handling task creation for the given method.
     *
     * Called when receiving a task-augmented inbound request.
     * This should be implemented by subclasses.
     */
    protected abstract assertTaskHandlerCapability(method: string): void;

    /**
     * Sends a request and waits for a response.
     *
     * For spec methods the result schema is resolved automatically from the method name
     * and the return type is method-keyed. For custom (non-spec) methods, pass a
     * `resultSchema` as the second argument; the response is validated against it and
     * the return type is inferred from the schema.
     *
     * Do not use this method to emit notifications! Use {@linkcode Protocol.notification | notification()} instead.
     */
    request<M extends RequestMethod>(
        request: { method: M; params?: Record<string, unknown> },
        options?: RequestOptions
    ): Promise<ResultTypeMap[M]>;
    request<T extends StandardSchemaV1>(
        request: Request,
        resultSchema: T,
        options?: RequestOptions
    ): Promise<StandardSchemaV1.InferOutput<T>>;
    request(request: Request, schemaOrOptions?: StandardSchemaV1 | RequestOptions, maybeOptions?: RequestOptions): Promise<unknown> {
        if (isStandardSchema(schemaOrOptions)) {
            return this._requestWithSchema(request, schemaOrOptions, maybeOptions);
        }
        const resultSchema = getResultSchema(request.method);
        if (!resultSchema) {
            throw new TypeError(`'${request.method}' is not a spec method; pass a result schema as the second argument to request().`);
        }
        return this._requestWithSchema(request, resultSchema, schemaOrOptions);
    }

    /**
     * Sends a request and waits for a response, using the provided schema for validation.
     *
     * This is the internal implementation used by SDK methods that need to specify
     * a particular result schema (e.g., for compatibility or task-specific schemas).
     */
    protected _requestWithSchema<T extends StandardSchemaV1>(
        request: Request,
        resultSchema: T,
        options?: RequestOptions
    ): Promise<StandardSchemaV1.InferOutput<T>> {
        const { relatedRequestId, resumptionToken, onresumptiontoken } = options ?? {};

        let onAbort: (() => void) | undefined;
        let cleanupMessageId: number | undefined;

        // Send the request
        return new Promise<StandardSchemaV1.InferOutput<T>>((resolve, reject) => {
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
                } catch (error) {
                    earlyReject(error);
                    return;
                }
            }

            options?.signal?.throwIfAborted();

            const messageId = this._requestMessageId++;
            cleanupMessageId = messageId;
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

            let responseReceived = false;

            const cancel = (reason: unknown) => {
                if (responseReceived) {
                    return;
                }
                this._progressHandlers.delete(messageId);

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
                responseReceived = true;

                if (response instanceof Error) {
                    return reject(response);
                }

                validateStandardSchema(resultSchema, response.result).then(parseResult => {
                    if (parseResult.success) {
                        resolve(parseResult.data);
                    } else {
                        reject(new SdkError(SdkErrorCode.InvalidResult, `Invalid result for ${request.method}: ${parseResult.error}`));
                    }
                }, reject);
            });

            onAbort = () => cancel(options?.signal?.reason);
            options?.signal?.addEventListener('abort', onAbort, { once: true });

            const timeout = options?.timeout ?? DEFAULT_REQUEST_TIMEOUT_MSEC;
            const timeoutHandler = () => cancel(new SdkError(SdkErrorCode.RequestTimeout, 'Request timed out', { timeout }));

            this._setupTimeout(messageId, timeout, options?.maxTotalTimeout, timeoutHandler, options?.resetTimeoutOnProgress ?? false);

            // Delegate task augmentation and routing to module (if registered)
            const responseHandler = (response: JSONRPCResultResponse | Error) => {
                const handler = this._responseHandlers.get(messageId);
                if (handler) {
                    handler(response);
                } else {
                    this._onerror(new Error(`Response handler missing for side-channeled request ${messageId}`));
                }
            };

            let outboundQueued = false;
            try {
                const taskResult = this._taskManager.processOutboundRequest(jsonrpcRequest, options, messageId, responseHandler, error => {
                    this._progressHandlers.delete(messageId);
                    reject(error);
                });
                if (taskResult.queued) {
                    outboundQueued = true;
                }
            } catch (error) {
                this._progressHandlers.delete(messageId);
                reject(error);
                return;
            }

            if (!outboundQueued) {
                // No related task or no module - send through transport normally
                this._transport.send(jsonrpcRequest, { relatedRequestId, resumptionToken, onresumptiontoken }).catch(error => {
                    this._progressHandlers.delete(messageId);
                    reject(error);
                });
            }
        }).finally(() => {
            // Per-request cleanup that must run on every exit path. Consolidated
            // here so new exit paths added to the promise body can't forget it.
            // _progressHandlers is NOT cleaned up here: _onresponse deletes it
            // conditionally (preserveProgress for task flows), and error paths
            // above delete it inline since no task exists in those cases.
            if (onAbort) {
                options?.signal?.removeEventListener('abort', onAbort);
            }
            if (cleanupMessageId !== undefined) {
                this._responseHandlers.delete(cleanupMessageId);
                this._cleanupTimeout(cleanupMessageId);
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

        this.assertNotificationCapability(notification.method);

        // Delegate task-related notification routing and JSONRPC building to TaskManager
        const taskResult = await this._taskManager.processOutboundNotification(notification, options);
        const queued = taskResult.queued;
        const jsonrpcNotification = taskResult.queued ? undefined : taskResult.jsonrpcNotification;

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
     *
     * For spec methods, pass `(method, handler)`; the request is parsed with the spec
     * schema and the handler receives the typed `Request`. For custom (non-spec)
     * methods, pass `(method, schemas, handler)`; `params` are validated against
     * `schemas.params` and the handler receives the parsed params object directly.
     * Supplying `schemas.result` types the handler's return value.
     *
     * @example Custom request method
     * ```ts source="./protocol.examples.ts#Protocol_setRequestHandler_customMethod"
     * const SearchParams = z.object({ query: z.string(), limit: z.number().optional() });
     * const SearchResult = z.object({ hits: z.array(z.string()) });
     *
     * protocol.setRequestHandler('acme/search', { params: SearchParams, result: SearchResult }, async (params, _ctx) => {
     *     return { hits: [`result for ${params.query}`] };
     * });
     * ```
     */
    setRequestHandler<M extends RequestMethod>(
        method: M,
        handler: (request: RequestTypeMap[M], ctx: ContextT) => ResultTypeMap[M] | Promise<ResultTypeMap[M]>
    ): void;
    setRequestHandler<P extends StandardSchemaV1, R extends StandardSchemaV1 | undefined = undefined>(
        method: string,
        schemas: { params: P; result?: R },
        handler: (params: StandardSchemaV1.InferOutput<P>, ctx: ContextT) => InferHandlerResult<R> | Promise<InferHandlerResult<R>>
    ): void;
    setRequestHandler(
        method: string,
        schemasOrHandler: RequestHandlerSchemas | ((request: unknown, ctx: ContextT) => Result | Promise<Result>),
        maybeHandler?: (params: unknown, ctx: ContextT) => Result | Promise<Result>
    ): void {
        this.assertRequestHandlerCapability(method);

        let stored: (request: JSONRPCRequest, ctx: ContextT) => Promise<Result>;

        if (typeof schemasOrHandler === 'function') {
            const schema = getRequestSchema(method);
            if (!schema) {
                throw new TypeError(
                    `'${method}' is not a spec request method; pass schemas as the second argument to setRequestHandler().`
                );
            }
            stored = (request, ctx) => Promise.resolve(schemasOrHandler(schema.parse(request), ctx));
        } else if (maybeHandler) {
            stored = async (request, ctx) => {
                const userParams = { ...request.params };
                delete userParams._meta;
                const parsed = await validateStandardSchema(schemasOrHandler.params, userParams);
                if (!parsed.success) {
                    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid params for ${method}: ${parsed.error}`);
                }
                return maybeHandler(parsed.data, ctx);
            };
        } else {
            throw new TypeError('setRequestHandler: handler is required');
        }

        this._requestHandlers.set(method, this._wrapHandler(method, stored));
    }

    /**
     * Hook for subclasses to wrap a registered request handler with role-specific
     * validation or behavior (e.g. `Server` validates `tools/call` results, `Client`
     * validates `elicitation/create` mode and result). Runs for both the 2-arg and
     * 3-arg registration paths. The default implementation is identity.
     *
     * Subclasses overriding this hook avoid redeclaring `setRequestHandler`'s overload set.
     */
    protected _wrapHandler(
        _method: string,
        handler: (request: JSONRPCRequest, ctx: ContextT) => Promise<Result>
    ): (request: JSONRPCRequest, ctx: ContextT) => Promise<Result> {
        return handler;
    }

    /**
     * Removes the request handler for the given method.
     */
    removeRequestHandler(method: RequestMethod | string): void {
        this._requestHandlers.delete(method);
    }

    /**
     * Asserts that a request handler has not already been set for the given method, in preparation for a new one being automatically installed.
     */
    assertCanSetRequestHandler(method: RequestMethod | string): void {
        if (this._requestHandlers.has(method)) {
            throw new Error(`A request handler for ${method} already exists, which would be overridden`);
        }
    }

    /**
     * Registers a handler to invoke when this protocol object receives a notification with the given method.
     *
     * Note that this will replace any previous notification handler for the same method.
     *
     * For spec methods, pass `(method, handler)`; the notification is parsed with the
     * spec schema. For custom (non-spec) methods, pass `(method, schemas, handler)`;
     * `params` are validated against `schemas.params` and the handler receives the
     * parsed params object directly. The raw notification is passed as the second
     * argument; `_meta` is recoverable via `notification.params?._meta`.
     */
    setNotificationHandler<M extends NotificationMethod>(
        method: M,
        handler: (notification: NotificationTypeMap[M]) => void | Promise<void>
    ): void;
    setNotificationHandler<P extends StandardSchemaV1>(
        method: string,
        schemas: { params: P },
        handler: (params: StandardSchemaV1.InferOutput<P>, notification: Notification) => void | Promise<void>
    ): void;
    setNotificationHandler(
        method: string,
        schemasOrHandler: { params: StandardSchemaV1 } | ((notification: unknown) => void | Promise<void>),
        maybeHandler?: (params: unknown, notification: Notification) => void | Promise<void>
    ): void {
        if (typeof schemasOrHandler === 'function') {
            const schema = getNotificationSchema(method);
            if (!schema) {
                throw new TypeError(
                    `'${method}' is not a spec notification method; pass schemas as the second argument to setNotificationHandler().`
                );
            }
            this._notificationHandlers.set(method, notification => Promise.resolve(schemasOrHandler(schema.parse(notification))));
            return;
        }

        if (!maybeHandler) {
            throw new TypeError('setNotificationHandler: handler is required');
        }
        this._notificationHandlers.set(method, async notification => {
            const userParams = { ...notification.params };
            delete userParams._meta;
            const parsed = await validateStandardSchema(schemasOrHandler.params, userParams);
            if (!parsed.success) {
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid params for notification ${method}: ${parsed.error}`);
            }
            await maybeHandler(parsed.data, notification);
        });
    }

    /**
     * Removes the notification handler for the given method.
     */
    removeNotificationHandler(method: NotificationMethod | string): void {
        this._notificationHandlers.delete(method);
    }
}

/**
 * Schema bundle accepted by {@linkcode Protocol.setRequestHandler | setRequestHandler}'s 3-arg form.
 *
 * `params` is required and validates the inbound `request.params`. `result` is optional;
 * when supplied it types the handler's return value (no runtime validation is performed
 * on the result).
 */
export interface RequestHandlerSchemas<
    P extends StandardSchemaV1 = StandardSchemaV1,
    R extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined
> {
    params: P;
    result?: R;
}

type InferHandlerResult<R extends StandardSchemaV1 | undefined> = R extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<R> : Result;

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
