import type {
    AuthInfo,
    ClientCapabilities,
    CreateMessageRequest,
    CreateMessageResult,
    CreateMessageResultWithTools,
    ElicitRequestFormParams,
    ElicitRequestURLParams,
    ElicitResult,
    LoggingLevel,
    Notification,
    Progress,
    Request,
    RequestId,
    RequestMeta,
    RequestMethod,
    Result,
    ResultTypeMap,
    ServerCapabilities
} from '../types/index.js';
import type { StandardSchemaV1 } from '../util/standardSchema.js';
import type { TaskRequestOptions } from './taskManager.js';
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
} & TransportSendOptions;

/**
 * Options that can be given per notification.
 */
export type NotificationOptions = {
    /**
     * May be used to indicate to the transport which incoming request to associate this outgoing notification with.
     */
    relatedRequestId?: RequestId;
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
     * Extension slot. Adapters and middleware populate keys here; handlers cast to the
     * extension's declared type to read them. Core never reads or writes this field.
     */
    ext?: Record<string, unknown>;
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
 * Per-request environment a transport adapter passes to {@linkcode Dispatcher.dispatch}.
 * Everything is optional; a bare `dispatch()` call works with no transport at all.
 *
 * @internal
 */
export type RequestEnv = {
    /**
     * Sends a request back to the peer (server→client elicitation/sampling, or
     * client→server nested calls). Supplied by {@linkcode StreamDriver} when running
     * over a persistent pipe, or by an HTTP adapter that has a backchannel. When
     * undefined, `ctx.mcpReq.send` throws {@linkcode SdkErrorCode.NotConnected}.
     */
    send?: (request: Request, options?: RequestOptions) => Promise<Result>;

    /**
     * Sends a notification back to the peer, related to the request being dispatched.
     * When supplied, `ctx.mcpReq.notify` calls this; when undefined, the dispatcher
     * yields the notification inline.
     */
    notify?: (notification: Notification) => Promise<void>;

    /** Validated auth token info for HTTP transports. */
    authInfo?: AuthInfo;

    /** Original HTTP `Request` (Fetch API), if any. */
    httpReq?: globalThis.Request;

    /** Abort signal for the inbound request. If omitted, a fresh controller is created. */
    signal?: AbortSignal;

    /** Transport session identifier (legacy `Mcp-Session-Id`). */
    sessionId?: string;

    /**
     * The originating request id, when the dispatch is on behalf of an inbound request.
     * Adapters propagate this so wrapped `send`/`notify` carry `relatedRequestId`.
     */
    relatedRequestId?: RequestId;

    /** Extension slot. Adapters and middleware populate keys here; copied onto `BaseContext.ext`. */
    ext?: Record<string, unknown>;
};

/**
 * The minimal contract a {@linkcode Dispatcher} owner needs to send outbound
 * requests/notifications to the connected peer. Implemented by
 * {@linkcode StreamDriver} for persistent pipes; request-shaped paths can supply
 * their own.
 *
 * @internal
 */
export interface Outbound {
    /** Send a request to the peer and resolve with the parsed result. */
    request<T extends StandardSchemaV1>(req: Request, resultSchema: T, options?: RequestOptions): Promise<StandardSchemaV1.InferOutput<T>>;
    /** Send a notification to the peer. */
    notification(notification: Notification, options?: NotificationOptions): Promise<void>;
    /** Close the underlying connection. */
    close(): Promise<void>;
    /** Inform the channel which protocol version was negotiated (for header echoing etc.). Optional. */
    setProtocolVersion?(version: string): void;
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
