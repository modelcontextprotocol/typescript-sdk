import { StateError } from '../errors.js';
import type {
    CancelledNotification,
    ClientCapabilities,
    JSONRPCErrorResponse,
    JSONRPCNotification,
    JSONRPCRequest,
    JSONRPCResponse,
    JSONRPCResultResponse,
    MessageExtraInfo,
    Notification,
    ProgressNotification,
    Request,
    RequestId,
    Result,
    ServerCapabilities
} from '../types/types.js';
import {
    CancelledNotificationSchema,
    ErrorCode,
    isJSONRPCErrorResponse,
    isJSONRPCNotification,
    isJSONRPCRequest,
    isJSONRPCResultResponse,
    McpError,
    PingRequestSchema,
    ProgressNotificationSchema
} from '../types/types.js';
import type { AnyObjectSchema, AnySchema, SchemaOutput } from '../util/zodCompat.js';
import { safeParse } from '../util/zodCompat.js';
import { getMethodLiteral, parseWithCompat } from '../util/zodJsonSchemaCompat.js';
import type { BaseRequestContext, ContextInterface } from './context.js';
import type { McpEventEmitter } from './events.js';
import { TypedEventEmitter } from './events.js';
import { HandlerRegistry } from './handlerRegistry.js';
import type {
    HandlerContextBase,
    OutgoingNotificationContext,
    OutgoingRequestContext,
    PluginContext,
    PluginRequestOptions,
    ProtocolPlugin,
    RequestContext
} from './plugin.js';
import { sortPluginsByPriority } from './plugin.js';
import { createPluginContext } from './pluginContext.js';
import type { ProgressCallback } from './progressManager.js';
import { ProgressManager } from './progressManager.js';
import type { ResponseMessage } from './responseMessage.js';
import { TimeoutManager } from './timeoutManager.js';
import type { Transport, TransportSendOptions } from './transport.js';

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
};

/**
 * The default request timeout, in miliseconds.
 */
export const DEFAULT_REQUEST_TIMEOUT_MSEC = 60_000;

/**
 * Options that can be given per request.
 *
 * ## Plugin Extension Pattern
 *
 * Plugins can define their own typed options by creating intersection types.
 * For type safety at call sites, use the plugin-specific type with `satisfies`:
 *
 * @example
 * ```typescript
 * import type { TaskRequestOptions } from '@modelcontextprotocol/core';
 *
 * // Type-safe task options
 * await ctx.sendRequest(req, schema, {
 *     task: { ttl: 60000 },
 *     relatedTask: { taskId: 'parent-123' }
 * } satisfies TaskRequestOptions);
 * ```
 *
 * The index signature allows plugins to read their options from the
 * `requestOptions` field in their `onBeforeSendRequest` hooks.
 */
export type RequestOptions = {
    /**
     * If set, requests progress notifications from the remote end (if supported).
     * When progress notifications are received, this callback will be invoked.
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

    /** Allow plugin-specific options via index signature */
    [key: string]: unknown;
} & TransportSendOptions;

/**
 * Options that can be given per notification.
 *
 * ## Plugin Extension Pattern
 *
 * Plugins can define their own typed options by creating intersection types.
 * For type safety at call sites, use the plugin-specific type with `satisfies`:
 *
 * @example
 * ```typescript
 * import type { TaskNotificationOptions } from '@modelcontextprotocol/core';
 *
 * // Type-safe task options
 * await ctx.sendNotification(notification, {
 *     relatedTask: { taskId: 'parent-123' }
 * } satisfies TaskNotificationOptions);
 * ```
 *
 * The index signature allows plugins to read their options from the
 * `notificationOptions` field in their `onBeforeSendNotification` hooks.
 */
export type NotificationOptions = {
    /**
     * May be used to indicate to the transport which incoming request to associate this outgoing notification with.
     */
    relatedRequestId?: RequestId;

    /** Allow plugin-specific options via index signature */
    [key: string]: unknown;
};

// ═══════════════════════════════════════════════════════════════════════════
// Error Interception
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Context provided to error interceptors.
 */
export interface ErrorInterceptionContext {
    /**
     * The type of error:
     * - 'protocol': Protocol-level errors (method not found, parse error, etc.)
     * - 'application': Application errors (handler threw an exception)
     */
    type: 'protocol' | 'application';

    /**
     * The method that was being called when the error occurred.
     */
    method: string;

    /**
     * The request ID from the JSON-RPC message.
     */
    requestId: RequestId;

    /**
     * For protocol errors, the fixed error code that cannot be changed.
     * For application errors, the error code that will be used (can be modified via returned Error).
     */
    errorCode: number;
}

/**
 * Result from an error interceptor that can modify the error response.
 */
export interface ErrorInterceptionResult {
    /**
     * Override the error message. If not provided, the original error message is used.
     */
    message?: string;

    /**
     * Additional data to include in the error response.
     */
    data?: unknown;

    /**
     * For application errors only: override the error code.
     * Ignored for protocol errors (they have fixed codes per MCP spec).
     */
    code?: number;
}

/**
 * Error interceptor function type.
 * Called before sending error responses, allows customizing the error.
 *
 * @param error - The original error
 * @param context - Context about where the error occurred
 * @returns Optional modifications to the error response, or void to use defaults
 */
export type ErrorInterceptor = (
    error: Error,
    context: ErrorInterceptionContext
) => ErrorInterceptionResult | void | Promise<ErrorInterceptionResult | void>;

// ═══════════════════════════════════════════════════════════════════════════
// Protocol Events
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Events emitted by the Protocol class.
 *
 * @example
 * ```typescript
 * const unsubscribe = protocol.events.on('connection:opened', ({ sessionId }) => {
 *   console.log(`Connected with session: ${sessionId}`);
 * });
 *
 * protocol.events.on('error', ({ error, context }) => {
 *   console.error(`Protocol error in ${context}:`, error);
 * });
 * ```
 */
export interface ProtocolEvents {
    [key: string]: unknown;

    /**
     * Emitted when a connection is successfully established.
     */
    'connection:opened': { sessionId?: string };

    /**
     * Emitted when the connection is closed.
     */
    'connection:closed': { sessionId?: string; reason?: string };

    /**
     * Emitted when an error occurs during protocol operations.
     */
    error: { error: Error; context?: string };
}

/**
 * Implements MCP protocol framing on top of a pluggable transport, including
 * features like request/response linking, notifications, and progress.
 */
export abstract class Protocol<SendRequestT extends Request, SendNotificationT extends Notification, SendResultT extends Result> {
    private _transport?: Transport;
    private _requestMessageId = 0;
    private _responseHandlers: Map<number, (response: JSONRPCResultResponse | Error) => void> = new Map();
    private _pendingDebouncedNotifications = new Set<string>();

    // Extracted managers
    private _timeoutManager = new TimeoutManager();
    private _progressManager = new ProgressManager();
    private _handlerRegistry = new HandlerRegistry<SendRequestT, SendNotificationT, SendResultT>();

    // Plugin system
    private _plugins: ProtocolPlugin<SendResultT>[] = [];

    private _requestResolvers: Map<RequestId, (response: JSONRPCResultResponse | Error) => void> = new Map();

    // Event emitter for observability
    private _events = new TypedEventEmitter<ProtocolEvents>();

    // Error interception callback
    private _errorInterceptor?: ErrorInterceptor;

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
     * Event emitter for observability and monitoring.
     *
     * Subscribe to events like connection lifecycle, errors, etc.
     *
     * @example
     * ```typescript
     * protocol.events.on('connection:opened', ({ sessionId }) => {
     *   console.log(`Connected: ${sessionId}`);
     * });
     *
     * protocol.events.on('error', ({ error }) => {
     *   console.error('Protocol error:', error);
     * });
     * ```
     */
    get events(): McpEventEmitter<ProtocolEvents> {
        return this._events;
    }

    /**
     * Sets an error interceptor that can customize error responses before they are sent.
     *
     * The interceptor is called for both protocol errors (method not found, etc.) and
     * application errors (when a handler throws). It can modify the error message and data,
     * and for application errors, can also change the error code.
     *
     * @param interceptor - The error interceptor function, or undefined to clear
     *
     * @example
     * ```typescript
     * server.setErrorInterceptor(async (error, ctx) => {
     *     console.error(`Error in ${ctx.method}: ${error.message}`);
     *     return {
     *         message: 'An error occurred',
     *         data: { originalMessage: error.message }
     *     };
     * });
     * ```
     */
    protected setErrorInterceptor(interceptor: ErrorInterceptor | undefined): void {
        this._errorInterceptor = interceptor;
    }

    /**
     * A handler to invoke for any request types that do not have their own handler installed.
     */
    get fallbackRequestHandler():
        | ((request: JSONRPCRequest, extra: ContextInterface<SendRequestT, SendNotificationT, BaseRequestContext>) => Promise<SendResultT>)
        | undefined {
        return this._handlerRegistry.fallbackRequestHandler;
    }

    set fallbackRequestHandler(
        handler:
            | ((
                  request: JSONRPCRequest,
                  extra: ContextInterface<SendRequestT, SendNotificationT, BaseRequestContext>
              ) => Promise<SendResultT>)
            | undefined
    ) {
        this._handlerRegistry.fallbackRequestHandler = handler;
    }

    /**
     * A handler to invoke for any notification types that do not have their own handler installed.
     */
    get fallbackNotificationHandler(): ((notification: Notification) => Promise<void>) | undefined {
        return this._handlerRegistry.fallbackNotificationHandler;
    }

    set fallbackNotificationHandler(handler: ((notification: Notification) => Promise<void>) | undefined) {
        this._handlerRegistry.fallbackNotificationHandler = handler;
    }

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
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Plugin System
    // ═══════════════════════════════════════════════════════════════════════════

    /**
     * Registers a plugin with the protocol.
     * Plugins are installed immediately and sorted by priority.
     *
     * @param plugin - The plugin to register
     * @returns this for chaining
     */
    usePlugin(plugin: ProtocolPlugin<SendResultT>): this {
        this._plugins.push(plugin);
        this._plugins = sortPluginsByPriority(this._plugins);

        // Install the plugin immediately
        const ctx = this._getPluginContext();
        plugin.install?.(ctx);

        return this;
    }

    /**
     * Retrieves a registered plugin by its class.
     * Returns undefined if the plugin is not registered.
     *
     * @param PluginClass - The plugin class to find
     * @returns The plugin instance or undefined
     *
     * @example
     * ```typescript
     * const taskPlugin = server.getPlugin(TaskPlugin);
     * if (taskPlugin) {
     *     // Access plugin-specific methods
     * }
     * ```
     */
    getPlugin<T extends ProtocolPlugin<SendResultT>>(PluginClass: abstract new (...args: unknown[]) => T): T | undefined {
        return this._plugins.find((p): p is T => p instanceof PluginClass);
    }

    /**
     * Cached plugin context, created once and reused for all plugins.
     */
    private _pluginContext?: PluginContext<SendResultT>;

    /**
     * Gets or creates the plugin context for plugin installation.
     * The context is created once and cached for reuse.
     */
    private _getPluginContext(): PluginContext<SendResultT> {
        if (!this._pluginContext) {
            this._pluginContext = createPluginContext<SendResultT>({
                protocol: this._createPluginHostProtocol(),
                getTransport: () => this._transport,
                resolvers: this._requestResolvers,
                progressManager: this._progressManager,
                reportError: error => this._onerror(error, 'plugin')
            });
        }
        return this._pluginContext;
    }

    /**
     * Creates the protocol interface for plugin context.
     * This provides a typed view of Protocol for the plugin system.
     */
    private _createPluginHostProtocol() {
        return {
            transport: this._transport,
            request: <T extends AnyObjectSchema>(request: JSONRPCRequest, resultSchema: T, options?: PluginRequestOptions) =>
                this.request(request as SendRequestT, resultSchema, options),
            setRequestHandler: <T extends AnyObjectSchema>(
                schema: T,
                handler: (
                    request: SchemaOutput<T>,
                    ctx: { mcpCtx: { requestId: RequestId; sessionId?: string }; requestCtx: { signal: AbortSignal } }
                ) => SendResultT | Promise<SendResultT>
            ) => this.setRequestHandler(schema, handler),
            setNotificationHandler: <T extends AnyObjectSchema>(
                schema: T,
                handler: (notification: SchemaOutput<T>) => void | Promise<void>
            ) => this.setNotificationHandler(schema, handler),
            removeRequestHandler: (method: string) => this.removeRequestHandler(method),
            removeNotificationHandler: (method: string) => this.removeNotificationHandler(method)
        };
    }

    /**
     * Calls onConnect on all plugins.
     */
    private async _notifyPluginsConnect(transport: Transport): Promise<void> {
        for (const plugin of this._plugins) {
            await plugin.onConnect?.(transport);
        }
    }

    /**
     * Calls onClose on all plugins.
     */
    private async _notifyPluginsClose(): Promise<void> {
        for (const plugin of this._plugins) {
            await plugin.onClose?.();
        }
    }

    /**
     * Checks if any plugin wants to route a message instead of the default transport.
     */
    private _findMessageRouter(
        message: JSONRPCRequest | JSONRPCNotification | JSONRPCResponse | JSONRPCErrorResponse,
        options?: TransportSendOptions
    ): ProtocolPlugin<SendResultT> | undefined {
        return this._plugins.find(p => p.shouldRouteMessage?.(message, options));
    }

    /**
     * Calls onRequest on all plugins, allowing them to modify the request.
     */
    private async _runPluginOnRequest(request: JSONRPCRequest, ctx: RequestContext): Promise<JSONRPCRequest> {
        let current = request;
        for (const plugin of this._plugins) {
            const modified = await plugin.onRequest?.(current, ctx);
            if (modified) {
                current = modified;
            }
        }
        return current;
    }

    /**
     * Calls onRequestResult on all plugins, allowing them to modify the result.
     */
    private async _runPluginOnRequestResult(request: JSONRPCRequest, result: Result, ctx: RequestContext): Promise<Result> {
        let current = result;
        for (const plugin of this._plugins) {
            const modified = await plugin.onRequestResult?.(request, current, ctx);
            if (modified) {
                current = modified;
            }
        }
        return current;
    }

    /**
     * Calls onRequestError on all plugins, allowing them to modify the error.
     */
    private async _runPluginOnRequestError(request: JSONRPCRequest, error: Error, ctx: RequestContext): Promise<Error> {
        let current = error;
        for (const plugin of this._plugins) {
            const modified = await plugin.onRequestError?.(request, current, ctx);
            if (modified) {
                current = modified;
            }
        }
        return current;
    }

    /**
     * Calls onNotification on all plugins, allowing them to modify the notification.
     */
    private async _runPluginOnNotification(notification: JSONRPCNotification): Promise<JSONRPCNotification> {
        let current = notification;
        for (const plugin of this._plugins) {
            const modified = await plugin.onNotification?.(current);
            if (modified) {
                current = modified;
            }
        }
        return current;
    }

    /**
     * Calls onBeforeSendRequest on all plugins, allowing them to augment the request.
     */
    private async _runPluginOnBeforeSendRequest(request: JSONRPCRequest, ctx: OutgoingRequestContext): Promise<JSONRPCRequest> {
        let current = request;
        for (const plugin of this._plugins) {
            const modified = await plugin.onBeforeSendRequest?.(current, ctx);
            if (modified) {
                current = modified;
            }
        }
        return current;
    }

    /**
     * Calls onBeforeSendNotification on all plugins, allowing them to augment the notification.
     */
    private async _runPluginOnBeforeSendNotification(
        notification: JSONRPCNotification,
        ctx: OutgoingNotificationContext
    ): Promise<JSONRPCNotification> {
        let current = notification;
        for (const plugin of this._plugins) {
            const modified = await plugin.onBeforeSendNotification?.(current, ctx);
            if (modified) {
                current = modified;
            }
        }
        return current;
    }

    /**
     * Calls onBuildHandlerContext on all plugins, merging additional context.
     */
    private async _runPluginOnBuildHandlerContext(
        request: JSONRPCRequest,
        baseContext: HandlerContextBase
    ): Promise<Record<string, unknown>> {
        const additions: Record<string, unknown> = {};
        for (const plugin of this._plugins) {
            const pluginContext = await plugin.onBuildHandlerContext?.(request, baseContext);
            if (pluginContext) {
                Object.assign(additions, pluginContext);
            }
        }
        return additions;
    }

    /**
     * Routes a message through plugins or transport.
     * Plugins can intercept messages (e.g., for task queueing) via shouldRouteMessage/routeMessage.
     */
    private async _routeMessage(
        message: JSONRPCRequest | JSONRPCNotification | JSONRPCResponse | JSONRPCErrorResponse,
        options?: TransportSendOptions
    ): Promise<void> {
        // Check if any plugin wants to route this message
        for (const plugin of this._plugins) {
            if (plugin.shouldRouteMessage?.(message, options)) {
                await plugin.routeMessage?.(message, options);
                return;
            }
        }

        // No plugin routing - send via transport
        await this._transport?.send(message, options);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Internal Handlers
    // ═══════════════════════════════════════════════════════════════════════════

    private async _oncancel(notification: CancelledNotification): Promise<void> {
        if (!notification.params.requestId) {
            return;
        }
        // Handle request cancellation
        const controller = this._handlerRegistry.getAbortController(notification.params.requestId);
        controller?.abort(notification.params.reason);
    }

    private _setupTimeout(
        messageId: number,
        timeout: number,
        maxTotalTimeout: number | undefined,
        onTimeout: () => void,
        resetTimeoutOnProgress: boolean = false
    ) {
        this._timeoutManager.setup(messageId, {
            timeout,
            maxTotalTimeout,
            resetTimeoutOnProgress,
            onTimeout
        });
    }

    private _resetTimeout(messageId: number): boolean {
        const info = this._timeoutManager.get(messageId);
        if (!info) return false;

        // Check max total timeout before delegating to manager
        if (info.maxTotalTimeout) {
            const totalElapsed = Date.now() - info.startTime;
            if (totalElapsed >= info.maxTotalTimeout) {
                this._timeoutManager.cleanup(messageId);
                throw McpError.fromError(ErrorCode.RequestTimeout, 'Maximum total timeout exceeded', {
                    maxTotalTimeout: info.maxTotalTimeout,
                    totalElapsed
                });
            }
        }

        return this._timeoutManager.reset(messageId);
    }

    private _cleanupTimeout(messageId: number) {
        this._timeoutManager.cleanup(messageId);
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
                this._onerror(new Error(`Unknown message type: ${JSON.stringify(message)}`), 'message-routing');
            }
        };

        await this._transport.start();

        // Notify plugins of connection
        await this._notifyPluginsConnect(transport);

        // Emit connection opened event
        this._events.emit('connection:opened', { sessionId: transport.sessionId });
    }

    private _onclose(): void {
        const responseHandlers = this._responseHandlers;
        this._responseHandlers = new Map();
        this._progressManager.clear();
        this._timeoutManager.clearAll();
        this._pendingDebouncedNotifications.clear();

        const error = McpError.fromError(ErrorCode.ConnectionClosed, 'Connection closed');

        // Capture sessionId before clearing transport
        const sessionId = this._transport?.sessionId;
        this._transport = undefined;
        this.onclose?.();

        // Emit connection closed event
        this._events.emit('connection:closed', { sessionId, reason: 'Connection closed' });

        // Notify plugins of close (fire and forget)
        this._notifyPluginsClose().catch(error_ => this._onerror(error_, 'plugin-close'));

        for (const handler of responseHandlers.values()) {
            handler(error);
        }
    }

    private _onerror(error: Error, context?: string): void {
        this.onerror?.(error);
        this._events.emit('error', { error, context });
    }

    /**
     * Sends a protocol-level error response (e.g., method not found, parse error).
     * Protocol errors have fixed error codes per MCP spec - the interceptor can only
     * modify the message and data, not the code.
     */
    private _sendProtocolError(request: JSONRPCRequest, errorCode: number, defaultMessage: string, sessionId: string | undefined): void {
        const error = new McpError(errorCode, defaultMessage);

        // Call error interceptor if set (async, fire-and-forget for the interception result usage)
        Promise.resolve()
            .then(async () => {
                let message = defaultMessage;
                let data: unknown;

                if (this._errorInterceptor) {
                    const ctx: ErrorInterceptionContext = {
                        type: 'protocol',
                        method: request.method,
                        requestId: request.id,
                        errorCode
                    };
                    const result = await this._errorInterceptor(error, ctx);
                    if (result) {
                        message = result.message ?? message;
                        data = result.data;
                        // Note: result.code is ignored for protocol errors (fixed codes per MCP spec)
                    }
                }

                const errorResponse: JSONRPCErrorResponse = {
                    jsonrpc: '2.0',
                    id: request.id,
                    error: {
                        code: errorCode,
                        message,
                        ...(data !== undefined && { data })
                    }
                };

                // Route error response through plugins
                await this._routeMessage(errorResponse, { sessionId });
            })
            .catch(error_ => this._onerror(new Error(`Failed to send error response: ${error_}`), 'send-error-response'));
    }

    private _onnotification(notification: JSONRPCNotification): void {
        const handler = this._handlerRegistry.getNotificationHandler(notification.method);

        // Ignore notifications not being subscribed to.
        if (handler === undefined) {
            return;
        }

        // Starting with Promise.resolve() puts any synchronous errors into the monad as well.
        Promise.resolve()
            .then(async () => {
                // Let plugins modify the notification
                const modifiedNotification = await this._runPluginOnNotification(notification);
                return handler(modifiedNotification);
            })
            .catch(error => this._onerror(new Error(`Uncaught error in notification handler: ${error}`), 'notification-handler'));
    }

    private _onrequest(request: JSONRPCRequest, extra?: MessageExtraInfo): void {
        const handler = this._handlerRegistry.getRequestHandler(request.method);

        // Capture the current transport at request time to ensure responses go to the correct client
        const capturedTransport = this._transport;

        if (handler === undefined) {
            // Handle method not found - this is a protocol error
            this._sendProtocolError(request, ErrorCode.MethodNotFound, 'Method not found', capturedTransport?.sessionId);
            return;
        }

        const abortController = this._handlerRegistry.createAbortController(request.id);
        const sessionId = capturedTransport?.sessionId;

        const baseExtra: ContextInterface<SendRequestT, SendNotificationT, BaseRequestContext> = this.createRequestContext({
            request,
            abortController,
            capturedTransport,
            extra
        });

        // Build plugin request context
        const pluginReqCtx: RequestContext = {
            requestId: request.id,
            method: request.method,
            sessionId
        };

        // Starting with Promise.resolve() puts any synchronous errors into the monad as well.
        Promise.resolve()
            // Let plugins modify the request
            .then(() => this._runPluginOnRequest(request, pluginReqCtx))
            .then(async modifiedRequest => {
                // Let plugins contribute additional context (e.g., task context)
                const additionalContext = await this._runPluginOnBuildHandlerContext(request, { sessionId, request });

                // Assign additional context properties to the existing context object
                // This preserves the prototype chain (instanceof checks work)
                if (additionalContext) {
                    Object.assign(baseExtra, additionalContext);
                }

                return handler(modifiedRequest, baseExtra);
            })
            .then(
                async result => {
                    if (abortController.signal.aborted) {
                        // Request was cancelled
                        return;
                    }

                    // Let plugins modify the result
                    const modifiedResult = await this._runPluginOnRequestResult(request, result, pluginReqCtx);

                    const response: JSONRPCResponse = {
                        result: modifiedResult as SendResultT,
                        jsonrpc: '2.0',
                        id: request.id
                    };

                    // Route response through plugins
                    await this._routeMessage(response, {
                        sessionId: capturedTransport?.sessionId
                    });
                },
                async error => {
                    if (abortController.signal.aborted) {
                        // Request was cancelled
                        return;
                    }

                    // Let plugins modify the error
                    const modifiedError = await this._runPluginOnRequestError(request, error, pluginReqCtx);

                    // Extract code and data from error (if it's an McpError or similar)
                    const errorWithCode = modifiedError as Error & { code?: number; data?: unknown };
                    const rawCode = errorWithCode.code;
                    let errorCode: number =
                        typeof rawCode === 'number' && Number.isSafeInteger(rawCode) ? rawCode : ErrorCode.InternalError;
                    let errorMessage = modifiedError.message ?? 'Internal error';
                    let errorData = errorWithCode.data;

                    // Call error interceptor if set (for application errors)
                    if (this._errorInterceptor) {
                        const ctx: ErrorInterceptionContext = {
                            type: 'application',
                            method: request.method,
                            requestId: request.id,
                            errorCode
                        };
                        const result = await this._errorInterceptor(modifiedError, ctx);
                        if (result) {
                            errorMessage = result.message ?? errorMessage;
                            errorData = result.data ?? errorData;
                            // For application errors, code can be overridden
                            if (result.code !== undefined && Number.isSafeInteger(result.code)) {
                                errorCode = result.code;
                            }
                        }
                    }

                    const errorResponse: JSONRPCErrorResponse = {
                        jsonrpc: '2.0',
                        id: request.id,
                        error: {
                            code: errorCode,
                            message: errorMessage,
                            ...(errorData !== undefined && { data: errorData })
                        }
                    };

                    // Route error response through plugins
                    await this._routeMessage(errorResponse, {
                        sessionId: capturedTransport?.sessionId
                    });
                }
            )
            .catch(error => this._onerror(new Error(`Failed to send response: ${error}`), 'send-response'))
            .finally(() => {
                this._handlerRegistry.removeAbortController(request.id);
            });
    }

    /**
     * Builds the common MCP context from a request.
     * This is used by subclass implementations of createRequestContext.
     */
    protected buildMcpContext(args: { request: JSONRPCRequest; sessionId: string | undefined }): {
        requestId: RequestId;
        method: string;
        _meta: Record<string, unknown> | undefined;
        sessionId: string | undefined;
    } {
        return {
            requestId: args.request.id,
            method: args.request.method,
            _meta: args.request.params?._meta,
            sessionId: args.sessionId
        };
    }

    /**
     * Creates the context object passed to request handlers.
     * Subclasses must implement this to provide the appropriate context type
     * (ClientContext for Client, ServerContext for Server).
     */
    protected abstract createRequestContext(args: {
        request: JSONRPCRequest;
        abortController: AbortController;
        capturedTransport: Transport | undefined;
        extra?: MessageExtraInfo;
    }): ContextInterface<SendRequestT, SendNotificationT, BaseRequestContext>;

    private _onprogress(notification: ProgressNotification): void {
        const { progressToken, ...params } = notification.params;
        const messageId = Number(progressToken);

        const handler = this._progressManager.getHandler(messageId);
        if (!handler) {
            this._onerror(
                new Error(`Received a progress notification for an unknown token: ${JSON.stringify(notification)}`),
                'progress-notification'
            );
            return;
        }

        const responseHandler = this._responseHandlers.get(messageId);
        const timeoutInfo = this._timeoutManager.get(messageId);

        if (timeoutInfo && responseHandler && timeoutInfo.resetTimeoutOnProgress) {
            try {
                this._resetTimeout(messageId);
            } catch (error) {
                // Clean up if maxTotalTimeout was exceeded
                this._responseHandlers.delete(messageId);
                this._progressManager.removeHandler(messageId);
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
                const error = new McpError(response.error.code, response.error.message, response.error.data);
                resolver(error);
            }
            return;
        }

        const handler = this._responseHandlers.get(messageId);
        if (handler === undefined) {
            this._onerror(new Error(`Received a response for an unknown message ID: ${JSON.stringify(response)}`), 'response-routing');
            return;
        }

        this._responseHandlers.delete(messageId);
        this._cleanupTimeout(messageId);

        // Let plugins process the response (e.g., for task progress management)
        // Plugins can inspect the response and manage progress handlers via getProgressManager()
        this._runPluginOnOutboundResponse(response, messageId);

        // Default: remove progress handler
        // Plugins that need to keep progress handlers active should re-register them in their onResponse hook
        this._progressManager.removeHandler(messageId);

        if (isJSONRPCResultResponse(response)) {
            handler(response);
        } else {
            const error = McpError.fromError(response.error.code, response.error.message, response.error.data);
            handler(error);
        }
    }

    /**
     * Calls onResponse on all plugins for outbound response processing.
     */
    private _runPluginOnOutboundResponse(response: JSONRPCResponse | JSONRPCErrorResponse, messageId: number): void {
        for (const plugin of this._plugins) {
            plugin.onResponse?.(response, messageId);
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
     * Sends a request and returns an AsyncGenerator that yields response messages.
     * The generator is guaranteed to end with either a 'result' or 'error' message.
     *
     * @example
     * ```typescript
     * const stream = protocol.requestStream(request, resultSchema, options);
     * for await (const message of stream) {
     *   switch (message.type) {
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
    protected async *requestStream<T extends AnySchema>(
        request: SendRequestT,
        resultSchema: T,
        options?: RequestOptions
    ): AsyncGenerator<ResponseMessage<SchemaOutput<T>>, void, void> {
        try {
            const result = await this.request(request, resultSchema, options);
            yield { type: 'result', result };
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
    request<T extends AnySchema>(request: SendRequestT, resultSchema: T, options?: RequestOptions): Promise<SchemaOutput<T>> {
        const { relatedRequestId, resumptionToken, onresumptiontoken } = options ?? {};

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
                } catch (error) {
                    earlyReject(error);
                    return;
                }
            }

            options?.signal?.throwIfAborted();

            const messageId = this._requestMessageId++;
            let jsonrpcRequest: JSONRPCRequest = {
                ...request,
                jsonrpc: '2.0',
                id: messageId
            };

            if (options?.onprogress) {
                this._progressManager.registerHandler(messageId, options.onprogress);
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
                this._progressManager.removeHandler(messageId);
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
                    .catch(error => this._onerror(new Error(`Failed to send cancellation: ${error}`), 'send-cancellation'));

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
                    const parseResult = safeParse(resultSchema, response.result);
                    if (parseResult.success) {
                        resolve(parseResult.data as SchemaOutput<T>);
                    } else {
                        // Type guard: if success is false, error is guaranteed to exist
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
            const timeoutHandler = () => cancel(McpError.fromError(ErrorCode.RequestTimeout, 'Request timed out', { timeout }));

            this._setupTimeout(messageId, timeout, options?.maxTotalTimeout, timeoutHandler, options?.resetTimeoutOnProgress ?? false);

            // Create plugin context for outgoing request
            const outgoingCtx: OutgoingRequestContext = {
                messageId,
                sessionId: this._transport?.sessionId,
                requestOptions: options as Record<string, unknown>,
                registerResolver: () => {
                    // Register resolver so responses can be routed back (used by task plugin)
                    const responseResolver = (response: JSONRPCResultResponse | Error) => {
                        const handler = this._responseHandlers.get(messageId);
                        if (handler) {
                            handler(response);
                        } else {
                            this._onerror(
                                new Error(`Response handler missing for side-channeled request ${messageId}`),
                                'side-channel-routing'
                            );
                        }
                    };
                    this._requestResolvers.set(messageId, responseResolver);
                }
            };

            // Let plugins augment the request (e.g., add task metadata)
            this._runPluginOnBeforeSendRequest(jsonrpcRequest, outgoingCtx)
                .then(modifiedRequest => {
                    jsonrpcRequest = modifiedRequest;

                    // Route message through plugins or transport
                    return this._routeMessage(jsonrpcRequest, {
                        relatedRequestId,
                        sessionId: this._transport?.sessionId,
                        resumptionToken,
                        onresumptiontoken
                    });
                })
                .catch(error => {
                    this._cleanupTimeout(messageId);
                    reject(error);
                });
        });
    }

    /**
     * Emits a notification, which is a one-way message that does not expect a response.
     */
    async notification(notification: SendNotificationT, options?: NotificationOptions): Promise<void> {
        if (!this._transport) {
            throw StateError.notConnected('send notification');
        }

        this.assertNotificationCapability(notification.method);

        const debouncedMethods = this._options?.debouncedNotificationMethods ?? [];
        // A notification can only be debounced if it's in the list AND it's "simple"
        // (i.e., has no parameters and no related request ID).
        const canDebounce = debouncedMethods.includes(notification.method) && !notification.params && !options?.relatedRequestId;

        // Create plugin context for outgoing notification
        const outgoingCtx: OutgoingNotificationContext = {
            sessionId: this._transport?.sessionId,
            relatedRequestId: options?.relatedRequestId,
            notificationOptions: options as Record<string, unknown>
        };

        if (canDebounce) {
            // If a notification of this type is already scheduled, do nothing.
            if (this._pendingDebouncedNotifications.has(notification.method)) {
                return;
            }

            // Mark this notification type as pending.
            this._pendingDebouncedNotifications.add(notification.method);

            // Schedule the actual send to happen in the next microtask.
            // This allows all synchronous calls in the current event loop tick to be coalesced.
            Promise.resolve().then(async () => {
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

                // Let plugins augment the notification
                jsonrpcNotification = await this._runPluginOnBeforeSendNotification(jsonrpcNotification, outgoingCtx);

                // Route notification through plugins
                this._routeMessage(jsonrpcNotification, {
                    ...options,
                    sessionId: this._transport?.sessionId
                }).catch(error => this._onerror(error, 'send-notification'));
            });

            // Return immediately.
            return;
        }

        let jsonrpcNotification: JSONRPCNotification = {
            ...notification,
            jsonrpc: '2.0'
        };

        // Let plugins augment the notification
        jsonrpcNotification = await this._runPluginOnBeforeSendNotification(jsonrpcNotification, outgoingCtx);

        // Route notification through plugins
        await this._routeMessage(jsonrpcNotification, {
            ...options,
            sessionId: this._transport?.sessionId
        });
    }

    /**
     * Registers a handler to invoke when this protocol object receives a request with the given method.
     *
     * Note that this will replace any previous request handler for the same method.
     */
    setRequestHandler<T extends AnyObjectSchema>(
        requestSchema: T,
        handler: (
            request: SchemaOutput<T>,
            ctx: ContextInterface<SendRequestT, SendNotificationT, BaseRequestContext>
        ) => SendResultT | Promise<SendResultT>
    ): void {
        const method = getMethodLiteral(requestSchema);
        this.assertRequestHandlerCapability(method);

        // Wrap handler to parse the request and delegate to registry
        this._handlerRegistry.setRequestHandler(method, (request, ctx) => {
            const parsed = parseWithCompat(requestSchema, request) as SchemaOutput<T>;
            return Promise.resolve(handler(parsed, ctx));
        });
    }

    /**
     * Removes the request handler for the given method.
     */
    removeRequestHandler(method: string): void {
        this._handlerRegistry.removeRequestHandler(method);
    }

    /**
     * Asserts that a request handler has not already been set for the given method, in preparation for a new one being automatically installed.
     */
    assertCanSetRequestHandler(method: string): void {
        if (this._handlerRegistry.hasRequestHandler(method)) {
            throw StateError.invalidState(`A request handler for ${method} already exists, which would be overridden`);
        }
    }

    /**
     * Registers a handler to invoke when this protocol object receives a notification with the given method.
     *
     * Note that this will replace any previous notification handler for the same method.
     */
    setNotificationHandler<T extends AnyObjectSchema>(
        notificationSchema: T,
        handler: (notification: SchemaOutput<T>) => void | Promise<void>
    ): void {
        const method = getMethodLiteral(notificationSchema);
        // Wrap handler to parse the notification and delegate to registry
        this._handlerRegistry.setNotificationHandler(method, notification => {
            const parsed = parseWithCompat(notificationSchema, notification) as SchemaOutput<T>;
            return Promise.resolve(handler(parsed));
        });
    }

    /**
     * Removes the notification handler for the given method.
     */
    removeNotificationHandler(method: string): void {
        this._handlerRegistry.removeNotificationHandler(method);
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
