import type {
    AuthInfo,
    ClientCapabilities,
    CreateMessageRequest,
    CreateMessageResult,
    CreateMessageResultWithTools,
    ElicitRequestFormParams,
    ElicitRequestURLParams,
    ElicitResult,
    JSONRPCMessage,
    LoggingLevel,
    Notification,
    Progress,
    RelatedTaskMetadata,
    Request,
    RequestId,
    RequestMeta,
    RequestMethod,
    ResultTypeMap,
    ServerCapabilities,
    TaskCreationParams
} from '../types/index.js';
import type { AnySchema, SchemaOutput } from '../util/schema.js';
import type { TaskContext, TaskManagerOptions, TaskRequestOptions } from './taskManager.js';
import type { TransportSendOptions } from './transport.js';

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
 * The minimal contract a {@linkcode Dispatcher} owner needs to send outbound
 * requests/notifications to the connected peer. Decouples {@linkcode McpServer}
 * (and the compat {@linkcode Protocol}) from any specific transport adapter:
 * they hold an `OutboundChannel`, not a `StreamDriver`.
 *
 * {@linkcode StreamDriver} implements this for persistent pipes. Request-shaped
 * paths can supply their own (e.g. routing through a backchannel).
 */
export interface OutboundChannel {
    /** Send a request to the peer and resolve with the parsed result. */
    request<T extends AnySchema>(req: Request, resultSchema: T, options?: RequestOptions): Promise<SchemaOutput<T>>;
    /** Send a notification to the peer. */
    notification(notification: Notification, options?: NotificationOptions): Promise<void>;
    /** Close the underlying connection. */
    close(): Promise<void>;
    /** Clear a registered progress callback by its message id. Optional; pipe-channels expose this for {@linkcode TaskManager}. */
    removeProgressHandler?(messageId: number): void;
    /** Inform the channel which protocol version was negotiated (for header echoing etc.). Optional. */
    setProtocolVersion?(version: string): void;
    /** Write a raw JSON-RPC message on the same stream as a prior request. Optional; pipe-only. */
    sendRaw?(message: JSONRPCMessage, options?: { relatedRequestId?: RequestId }): Promise<void>;
}

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
        send: <M extends RequestMethod>(
            request: { method: M; params?: Record<string, unknown> },
            options?: TaskRequestOptions
        ) => Promise<ResultTypeMap[M]>;

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

    // ─── v1 flat aliases (deprecated) ────────────────────────────────────
    // v1's RequestHandlerExtra exposed these at the top level. v2 nests them
    // under {@linkcode mcpReq} / {@linkcode http}. The flat forms are kept
    // typed (and populated at runtime by McpServer.buildContext) so v1 handler
    // code keeps compiling. Prefer the nested paths for new code.

    /** @deprecated Use {@linkcode mcpReq.signal}. */
    signal?: AbortSignal;
    /** @deprecated Use {@linkcode mcpReq.id}. */
    requestId?: RequestId;
    /** @deprecated Use {@linkcode mcpReq._meta}. */
    _meta?: RequestMeta;
    /** @deprecated Use {@linkcode mcpReq.notify}. */
    sendNotification?: (notification: Notification) => Promise<void>;
    /** @deprecated Use {@linkcode mcpReq.send}. */
    sendRequest?: <M extends RequestMethod>(
        request: { method: M; params?: Record<string, unknown> },
        options?: TaskRequestOptions
    ) => Promise<ResultTypeMap[M]>;
    /** @deprecated Use {@linkcode http.authInfo}. */
    authInfo?: AuthInfo;
    /** @deprecated v1 carried raw request info here. v2 surfaces the web `Request` via {@linkcode ServerContext.http}. */
    requestInfo?: globalThis.Request;
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
