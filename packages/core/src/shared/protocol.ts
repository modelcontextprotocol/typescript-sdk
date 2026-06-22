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
    HandlerResultTypeMap,
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
    Request,
    RequestId,
    RequestMeta,
    RequestMetaEnvelope,
    RequestMethod,
    RequestTypeMap,
    Result,
    ResultTypeMap,
    ServerCapabilities
} from '../types/index.js';
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    isJSONRPCErrorResponse,
    isJSONRPCNotification,
    isJSONRPCRequest,
    isJSONRPCResultResponse,
    LOG_LEVEL_META_KEY,
    PROTOCOL_VERSION_META_KEY,
    ProtocolError,
    ProtocolErrorCode,
    SUPPORTED_PROTOCOL_VERSIONS
} from '../types/index.js';
import type { StandardSchemaV1 } from '../util/standardSchema.js';
import { isStandardSchema, validateStandardSchema } from '../util/standardSchema.js';
import { bootstrapOutboundCodec } from '../wire/bootstrap.js';
import type { LiftedWireMaterial, WireCodec } from '../wire/codec.js';
import { classifiedWireEra, codecForVersion, isSpecNotificationMethod, isSpecRequestMethod, MODERN_WIRE_REVISION } from '../wire/codec.js';
import { manualInputRequiredValue, partitionInputResponses } from './inputRequiredEngine.js';
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
     * Protocol versions supported. The legacy `initialize` handshake offers and
     * falls back to the first 2025-era entry in the list (the client sends it,
     * the server counter-offers it); 2026-era entries are only ever selected via
     * `server/discover`. Passed to transport during {@linkcode Protocol.connect | connect()}.
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
     *
     * For multi-round-trip requests fulfilled by the auto-fulfilment driver
     * (protocol revision 2026-07-28), the budget bounds the WHOLE flow: every
     * retry leg is given only the time remaining.
     */
    maxTotalTimeout?: number;

    /**
     * Manual multi-round-trip mode for this call (protocol revision
     * 2026-07-28): when the response is an `input_required` result, hand it
     * back to the caller instead of auto-fulfilling it (or raising a typed
     * error). The resolved value is the neutral input-required shape
     * (`resultType: 'input_required'`, `inputRequests?`, `requestState?`);
     * wrap the result schema with `withInputRequired()` on the explicit
     * schema path to type both outcomes. The caller is then responsible for
     * gathering the requested input and retrying the original request with
     * `inputResponses` / `requestState` params and a fresh request.
     *
     * Default: `false`.
     */
    allowInputRequired?: boolean;
} & TransportSendOptions;

/**
 * Flow context handed to {@linkcode Protocol._resolveNonCompleteResult}: the
 * originating request, its options, the wire codec that decoded the response,
 * the timestamp the originating leg was issued at (for whole-flow timeout
 * accounting), and a `retry` closure that re-enters the request funnel with
 * fresh params on a fresh request id.
 */
export interface NonCompleteResultFlow<T extends StandardSchemaV1 = StandardSchemaV1> {
    codec: WireCodec;
    request: Request;
    resultSchema: T;
    options: RequestOptions | undefined;
    flowStartedAt: number;
    /** Re-issue the originating request with the given params and per-leg options. */
    retry(params: Record<string, unknown> | undefined, legOptions: RequestOptions): Promise<unknown>;
}

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
 * The reserved per-request `_meta` envelope keys (protocol revision
 * 2026-07-28). The protocol layer lifts these out of inbound `_meta` before
 * handlers run and surfaces them at `ctx.mcpReq.envelope` — they are
 * wire-level bookkeeping, not handler material.
 */
const RESERVED_ENVELOPE_META_KEYS: readonly string[] = [
    PROTOCOL_VERSION_META_KEY,
    CLIENT_INFO_META_KEY,
    CLIENT_CAPABILITIES_META_KEY,
    LOG_LEVEL_META_KEY
];

/**
 * Top-level params members carrying multi-round-trip driver material
 * (protocol revision 2026-07-28). The spec reserves these names on
 * client-initiated REQUESTS only — notification params keep them untouched
 * (a vendor notification may legitimately use the same names).
 */
const RETRY_PARAMS_KEYS = ['inputResponses', 'requestState'] as const;

/**
 * Lift wire-only material out of an inbound message so handlers see exactly
 * the 2025-era shape, and surface it for the protocol layer (requests: via
 * `ctx.mcpReq`). What counts as wire-only depends on the message kind: the
 * reserved envelope `_meta` keys are reserved on every message, while the
 * multi-round-trip retry fields (`inputResponses`/`requestState`) are
 * reserved on client-initiated requests only — so notifications get only the
 * envelope lift, and their top-level params stay untouched. Messages without
 * wire-only material are returned unchanged (same reference).
 */
function liftWireOnlyMaterial<T extends JSONRPCRequest | JSONRPCNotification>(
    message: T,
    kind: 'request' | 'notification'
): { message: T; lifted: LiftedWireMaterial } {
    const params = (message as { params?: unknown }).params;
    if (!isPlainObject(params)) return { message, lifted: {} };

    const meta = params._meta;
    const envelopeKeys = isPlainObject(meta) ? RESERVED_ENVELOPE_META_KEYS.filter(key => key in meta) : [];
    const retryKeys = kind === 'request' ? RETRY_PARAMS_KEYS.filter(key => key in params) : [];
    if (envelopeKeys.length === 0 && retryKeys.length === 0) return { message, lifted: {} };

    const lifted: LiftedWireMaterial = {};
    const nextParams: Record<string, unknown> = { ...params };

    if (envelopeKeys.length > 0 && isPlainObject(meta)) {
        const envelope: Record<string, unknown> = {};
        const nextMeta: Record<string, unknown> = { ...meta };
        for (const key of envelopeKeys) {
            envelope[key] = meta[key];
            delete nextMeta[key];
        }
        // Surfaced as received; validation/enforcement is the dispatch-time
        // classifier's job, not the lift's.
        lifted.envelope = envelope as Partial<RequestMetaEnvelope>;
        if (Object.keys(nextMeta).length > 0) {
            nextParams._meta = nextMeta;
        } else {
            delete nextParams._meta;
        }
    }

    for (const key of retryKeys) {
        // Driver material reaches the protocol layer un-deleted, verbatim.
        if (key === 'inputResponses') lifted.inputResponses = nextParams[key] as Record<string, unknown>;
        if (key === 'requestState') lifted.requestState = nextParams[key] as string;
        delete nextParams[key];
    }

    return { message: { ...message, params: nextParams } as T, lifted };
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
         * Metadata from the original request, with the reserved
         * `io.modelcontextprotocol/*` envelope keys already lifted out
         * (readable via `ctx.mcpReq.envelope`).
         */
        _meta?: RequestMeta;

        /**
         * The per-request `_meta` envelope (protocol revision 2026-07-28):
         * the reserved `io.modelcontextprotocol/*` keys carried by the
         * request, lifted out of the `_meta` the handler sees. Surfaced as
         * received — `Partial` because only the keys the request actually
         * carried are present (envelope requiredness is enforced per request
         * at dispatch time, not by the lift); only present at all when the
         * request carried envelope keys.
         */
        envelope?: Partial<RequestMetaEnvelope>;

        /**
         * Multi-round-trip input responses carried by a retried request
         * (protocol revision 2026-07-28), lifted out of the params the
         * handler sees. Entries are the BARE response objects keyed by the
         * identifiers the server assigned in `inputRequests`; entries that do
         * not look like bare responses (e.g. a `{method, result}` wrapper)
         * are dropped and their keys recorded in `droppedInputResponseKeys`.
         *
         * The values arrive from the client and are NOT validated by the SDK
         * — treat them as untrusted input.
         */
        inputResponses?: Record<string, unknown>;

        /**
         * Keys of `inputResponses` entries the SDK dropped because they were
         * not bare response objects (for example the wrapped `{method,
         * result}` shape some peers emit). Surfaced so a handler can re-issue
         * the corresponding input request rather than hard-fail.
         */
        droppedInputResponseKeys?: string[];

        /**
         * Multi-round-trip request state echoed by a retried request
         * (protocol revision 2026-07-28), lifted out of the params the
         * handler sees. Driver material — present verbatim when sent.
         *
         * SECURITY: `requestState` round-trips through the client and MUST be
         * treated as attacker-controlled input. The SDK applies no integrity
         * protection: if this value influences authorization, resource
         * access, or business logic, the server MUST integrity-protect it
         * (e.g. HMAC or AEAD) when minting it and MUST verify it here,
         * rejecting state that fails verification (spec:
         * basic/patterns/mrtr, server requirements 4–5).
         */
        requestState?: string;

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
                options?: RequestOptions
            ): Promise<ResultTypeMap[M]>;
            <T extends StandardSchemaV1>(
                request: Request,
                resultSchema: T,
                options?: RequestOptions
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
};

/**
 * Context provided to server-side request handlers, extending {@linkcode BaseContext} with server-specific fields.
 */
export type ServerContext = BaseContext & {
    mcpReq: {
        /**
         * Send a log message notification to the client.
         * Respects the client's log level filter set via logging/setLevel.
         *
         * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).
         * Remains functional during the deprecation window (at least twelve months).
         * Migrate to stderr logging (STDIO servers) or OpenTelemetry.
         */
        log: (level: LoggingLevel, data: unknown, logger?: string) => Promise<void>;

        /**
         * Send an elicitation request to the client, requesting user input.
         *
         * @deprecated Throws on a 2026-07-28-era request — return `inputRequired(...)`
         * (multi-round-trip) from the handler instead. The 2025 push-style server-to-client request model is
         * replaced by input_required results in the 2026-07-28 protocol. If your factory serves
         * both eras, this only works on the legacy path.
         */
        elicitInput: (params: ElicitRequestFormParams | ElicitRequestURLParams, options?: RequestOptions) => Promise<ElicitResult>;

        /**
         * Request LLM sampling from the client.
         *
         * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577).
         * Throws on a 2026-07-28-era request — return `inputRequired(...)` (multi-round-trip)
         * from the handler instead, or migrate to calling LLM provider APIs directly. The 2025 push-style
         * server-to-client request model is replaced by input_required results in the 2026-07-28
         * protocol. If your factory serves both eras, this only works on the legacy path.
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

/*
 * Package-internal write access to Protocol's negotiated-protocol-version state.
 *
 * The negotiated version is a protected field on Protocol that the role classes
 * (Client/Server) assign directly. Tests and the modern-era server entry still
 * need to set it from outside the class hierarchy, so Protocol's static
 * initializer hands this module-scoped closure privileged access and
 * `setNegotiatedProtocolVersion` re-exports it on the core INTERNAL barrel
 * only — deliberately not public API.
 */
let writeNegotiatedProtocolVersion: <ContextT extends BaseContext>(instance: Protocol<ContextT>, version: string | undefined) => void;

/**
 * Package-internal write channel for a {@linkcode Protocol} instance's
 * negotiated protocol version, for callers outside the class hierarchy:
 * tests and the (future) modern-era server entry that marks a factory
 * instance modern at binding time. Exported on the core internal barrel
 * only — never public API.
 */
export function setNegotiatedProtocolVersion<ContextT extends BaseContext>(
    instance: Protocol<ContextT>,
    version: string | undefined
): void {
    writeNegotiatedProtocolVersion(instance, version);
}

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
    private _notificationHandlers: Map<string, (notification: JSONRPCNotification, codec: WireCodec) => Promise<void>> = new Map();
    private _responseHandlers: Map<number, (response: JSONRPCResultResponse | Error) => void> = new Map();
    private _progressHandlers: Map<number, ProgressCallback> = new Map();
    private _timeoutInfo: Map<number, TimeoutInfo> = new Map();
    private _pendingDebouncedNotifications = new Set<string>();

    /**
     * The protocol version negotiated for the current connection (`undefined`
     * before negotiation completes), which determines the wire era this
     * instance speaks. Set by the SDK's negotiation and initialize paths
     * (`Client.connect`, `Server._oninitialize`).
     */
    protected _negotiatedProtocolVersion?: string;

    static {
        writeNegotiatedProtocolVersion = (instance, version) => {
            instance._negotiatedProtocolVersion = version;
        };
    }

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
     * Builds the context object for request handlers. Subclasses must override
     * to return the appropriate context type (e.g., ServerContext adds HTTP request info).
     */
    protected abstract buildContext(ctx: BaseContext, transportInfo?: MessageExtraInfo): ContextT;

    /**
     * Drop consult for inbound messages whose transport did not classify them
     * at the edge — long-lived channels such as stdio, where a role class may
     * need to decline traffic the negotiated era has no answer for (the
     * client-side inbound-request drop on modern-era connections: the
     * 2026-07-28 era has no server→client request channel, and on stdio the
     * client must never write JSON-RPC responses).
     *
     * Consulted ONLY when the transport supplied no
     * {@linkcode MessageExtraInfo.classification}: edge-classified traffic
     * never reaches the hook. Returning `'drop'` discards the message without
     * writing any response (requests are surfaced via `onerror`). The base
     * implementation returns `undefined`: unclassified traffic keeps today's
     * dispatch path unchanged. Era selection never happens here — era is
     * instance state, owned by the serving entry that constructed and
     * connected the instance.
     */
    protected _shouldDropInbound(_message: JSONRPCRequest | JSONRPCNotification): 'drop' | undefined {
        return undefined;
    }

    /**
     * The per-request `_meta` envelope this instance attaches to every outgoing
     * request and notification, when one applies. The base implementation
     * returns `undefined` (no envelope — the 2025-era posture, so legacy-era
     * outbound traffic is byte-identical to a build without this seam).
     * `Client` overrides it on a connection that negotiated a modern (2026-07-28+)
     * era to return the reserved protocol-version / client-info /
     * client-capabilities keys. User-supplied `_meta` keys take precedence over
     * the auto-attached ones.
     */
    protected _outboundMetaEnvelope(): Readonly<Record<string, unknown>> | undefined {
        return undefined;
    }

    /**
     * Attach this instance's outbound `_meta` envelope (when one is configured)
     * to a request or notification. A no-op when the seam returns `undefined`
     * — the message returns by reference, so the legacy-era wire stays
     * byte-identical. User-supplied `_meta` keys are spread last so they win
     * over the auto-attached envelope keys.
     */
    private _envelopeOutbound<T extends JSONRPCRequest | JSONRPCNotification>(message: T): T {
        const envelope = this._outboundMetaEnvelope();
        if (envelope === undefined) {
            return message;
        }
        const params = (message.params ?? {}) as { _meta?: Record<string, unknown> };
        return {
            ...message,
            params: { ...params, _meta: { ...envelope, ...params._meta } }
        };
    }

    /**
     * Extension point for non-`complete` decoded results in the response
     * funnel: a result the wire codec discriminated into a kind other than
     * `'complete'` or `'invalid'` is handed here for the role class to
     * resolve. The base default surfaces it as a typed
     * {@linkcode SdkErrorCode.UnsupportedResultType} error (no retry).
     *
     * Intended consumers (named so the seam stays accountable):
     * - the `Client`'s multi-round-trip auto-fulfilment engine, which fulfils
     *   `'input_required'` results through the registered
     *   elicitation/sampling/roots handlers and retries via `flow.retry`;
     * - a future client-side terminal-result handler for
     *   `subscriptions/listen`, when the spec defines one.
     *
     * `Server` instances never receive `input_required` responses on their
     * outbound legs and leave the base behavior in place.
     */
    protected _resolveNonCompleteResult<T extends StandardSchemaV1>(
        decoded: ReturnType<WireCodec['decodeResult']> & { kind: 'input_required' },
        flow: NonCompleteResultFlow<T>
    ): Promise<unknown> {
        return Promise.reject(
            new SdkError(SdkErrorCode.UnsupportedResultType, `Unsupported result type '${decoded.kind}' for ${flow.request.method}`, {
                resultType: decoded.kind,
                method: flow.request.method
            })
        );
    }

    /**
     * Protected accessor for a registered request handler. Used by role
     * classes that dispatch synthesized requests through the same stored
     * handler chain (e.g. the `Client` fulfilling an embedded multi-round-trip
     * input request).
     */
    protected _getRequestHandler(method: string): ((request: JSONRPCRequest, ctx: ContextT) => Promise<Result>) | undefined {
        return this._requestHandlers.get(method);
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
                this._onnotification(message, extra);
            } else {
                this._onerror(new Error(`Unknown message type: ${JSON.stringify(message)}`));
            }
        };

        // Pass supported protocol versions to transport for header validation
        transport.setSupportedProtocolVersions?.(this._supportedProtocolVersions);

        await this._transport.start();
    }

    /**
     * Transport-close hook. Subclass overrides MUST call `super._onclose()`
     * after their own cleanup — base teardown (response-handler settlement,
     * timeout clearing, in-flight request abort) does not run otherwise.
     */
    protected _onclose(): void {
        const responseHandlers = this._responseHandlers;
        this._responseHandlers = new Map();
        this._progressHandlers.clear();
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

    /**
     * Inbound-notification dispatch. Subclass overrides MUST delegate
     * unmatched traffic to `super._onnotification(rawNotification, extra)` —
     * an override that consumes only what it owns and falls through to base
     * dispatch for everything else.
     */
    protected _onnotification(rawNotification: JSONRPCNotification, extra?: MessageExtraInfo): void {
        // Hide wire-only material from notification handlers too — but ONLY
        // the reserved envelope `_meta` keys (the retry params names are
        // reserved on requests, not notifications). There is no
        // per-notification context, so the lifted envelope keys are dropped,
        // not surfaced; the protocol layer owns them.
        const { message: notification } = liftWireOnlyMaterial(rawNotification, 'notification');

        // Era is instance state: the negotiated protocol version selects the
        // codec for everything this connection receives (legacy until
        // negotiated). Classification is never a per-message era switch — an
        // edge classification is validated against the instance era below.
        const codec = this._negotiatedWireCodec();

        // Drop consult (only when the transport did not classify; edge-
        // classified traffic never reaches the hook): a role class may decline
        // unclassified inbound traffic the negotiated era has no answer for.
        if (extra?.classification === undefined && this._shouldDropInbound(rawNotification) === 'drop') {
            return;
        }

        // Edge→instance handoff check: a classification that disagrees with
        // the instance era means the entry routed another era's traffic onto
        // this instance. That is a routing error — drop the notification and
        // surface it out of band; never serve it on a guessed era.
        if (extra?.classification !== undefined) {
            const classified = classifiedWireEra(extra.classification);
            if (classified !== codec.era) {
                this._onerror(
                    new Error(
                        `Era mismatch on inbound notification '${notification.method}': classified as ${classified} but this instance serves ${codec.era}`
                    )
                );
                return;
            }
        }

        // Era gate — deletions are physical: a spec notification that is not
        // in this era's registry is dropped even when a handler is
        // registered (notifications get no error response; silent drop is
        // the protocol-correct outcome, matching today's unknown-method
        // posture). Methods outside the spec universe are consumer-owned
        // extension notifications and stay era-blind.
        if (isSpecNotificationMethod(notification.method) && !codec.hasNotificationMethod(notification.method)) {
            return;
        }

        const handler = this._notificationHandlers.get(notification.method);
        const fallback = this.fallbackNotificationHandler;

        // Ignore notifications not being subscribed to.
        if (handler === undefined && fallback === undefined) {
            return;
        }

        // Starting with Promise.resolve() puts any synchronous errors into the monad as well.
        Promise.resolve()
            .then(() => (handler === undefined ? fallback!(notification) : handler(notification, codec)))
            .catch(error => this._onerror(new Error(`Uncaught error in notification handler: ${error}`)));
    }

    private _onrequest(rawRequest: JSONRPCRequest, extra?: MessageExtraInfo): void {
        // Lift wire-only material before dispatch: handlers (including the
        // fallback handler and the per-method schema parse) see exactly the
        // 2025-era shape; the envelope and retry fields surface via ctx.
        const { message: request, lifted } = liftWireOnlyMaterial(rawRequest, 'request');

        // Era is instance state: the negotiated protocol version selects the
        // codec for everything this connection receives (legacy until
        // negotiated). Classification (Q2; produced at the transport/entry
        // edge — this layer only CONSUMES MessageExtraInfo.classification) is
        // never a per-message era switch — it is validated against the
        // instance era below. Hand-wired legacy transports never classify, so
        // their behavior is untouched.
        const codec = this._negotiatedWireCodec();

        // Drop consult (only when the transport did not classify; edge-
        // classified traffic never reaches the hook): a role class may decline
        // unclassified inbound traffic the negotiated era has no answer for.
        if (extra?.classification === undefined && this._shouldDropInbound(rawRequest) === 'drop') {
            this._onerror(new Error(`Dropped inbound request '${rawRequest.method}': not servable on this connection's protocol era`));
            return;
        }

        // Capture the current transport at request time to ensure responses go to the correct client
        const capturedTransport = this._transport;

        const sendErrorResponse = (code: number, message: string, data?: unknown) => {
            const errorResponse: JSONRPCErrorResponse = {
                jsonrpc: '2.0',
                id: request.id,
                error: { code, message, ...(data !== undefined && { data }) }
            };
            capturedTransport?.send(errorResponse).catch(error => this._onerror(new Error(`Failed to send an error response: ${error}`)));
        };

        // Edge→instance handoff check: a classification that disagrees with
        // the instance era means the entry routed another era's traffic onto
        // this instance. That is a routing error: answer with the typed era
        // error (−32004 Unsupported protocol version) and surface it out of
        // band — never serve the request on a guessed era.
        if (extra?.classification !== undefined) {
            const classified = classifiedWireEra(extra.classification);
            if (classified !== codec.era) {
                this._onerror(
                    new Error(
                        `Era mismatch on inbound request '${request.method}': classified as ${classified} but this instance serves ${codec.era}`
                    )
                );
                // `requested` echoes the protocol version the classification
                // actually named when it carried one; the wire-era label is
                // only the fallback for classifications without an exact
                // revision.
                const requested = extra.classification.revision ?? classified;
                sendErrorResponse(ProtocolErrorCode.UnsupportedProtocolVersion, `Unsupported protocol version: ${requested}`, {
                    // Per spec, `supported` is the full list of protocol
                    // versions the receiver supports — not just the version
                    // this connection is on — so the peer can pick a mutually
                    // supported version from the error alone. (Revisit when
                    // instances are bound to the modern era at the entry: a
                    // bound instance's configured list may not name the
                    // revision it was bound to.)
                    supported: this._supportedProtocolVersions,
                    requested
                });
                return;
            }
        }

        // Era gate — deletions are physical: a spec method that is not in
        // this era's registry is −32601 BY ABSENCE, before any handler
        // lookup, even when a handler is registered (a custom handler cannot
        // shadow a deleted spec method across eras). Methods outside the
        // spec universe are consumer-owned extension methods and stay
        // era-blind.
        if (isSpecRequestMethod(request.method) && !codec.hasRequestMethod(request.method)) {
            sendErrorResponse(ProtocolErrorCode.MethodNotFound, 'Method not found');
            return;
        }

        const handler = this._requestHandlers.get(request.method) ?? this.fallbackRequestHandler;

        if (handler === undefined) {
            sendErrorResponse(ProtocolErrorCode.MethodNotFound, 'Method not found');
            return;
        }

        // Envelope enforcement: the 2026 era requires the per-request `_meta`
        // envelope on every request (spec.types.2026-07-28 RequestParams).
        // The lift extracted it above; the era codec validates requiredness.
        // Deliberately AFTER the era gate and the handler-existence check:
        // an unknown method answers −32601 even when the envelope is also
        // missing — method existence outranks parameter validity. (The
        // canonical precedence table for the full inbound validation ladder
        // arrives with the validation-ladder milestone; this site encodes
        // only the −32601-over-−32602 rule.)
        const envelopeError = codec.checkInboundEnvelope(lifted);
        if (envelopeError !== undefined) {
            sendErrorResponse(ProtocolErrorCode.InvalidParams, envelopeError);
            return;
        }

        // Related sends resolve through the SAME instance era as every other
        // sender (the per-request/instance asymmetry is deliberately gone):
        // the codec is resolved at send time from the connection state.
        const sendNotification = (notification: Notification, options?: NotificationOptions) =>
            this._notificationViaCodec(this._resolveOutboundCodec(notification.method), notification, {
                ...options,
                relatedRequestId: request.id
            });
        const sendRequest = <U extends StandardSchemaV1>(r: Request, resultSchema: U, options?: RequestOptions) =>
            this._requestWithSchemaViaCodec(this._resolveOutboundCodec(r.method), r, resultSchema, {
                ...options,
                relatedRequestId: request.id
            });

        const abortController = new AbortController();
        this._requestHandlerAbortControllers.set(request.id, abortController);

        // Multi-round-trip retry material: only BARE response objects are
        // surfaced to the handler; entries that look like a wrapped
        // `{method, result}` shape (or are not objects at all) are dropped
        // and their keys recorded so the handler can re-issue the input
        // request instead of hard-failing (D-059 posture).
        const partitionedInputResponses = lifted.inputResponses === undefined ? undefined : partitionInputResponses(lifted.inputResponses);

        const baseCtx: BaseContext = {
            sessionId: capturedTransport?.sessionId,
            mcpReq: {
                id: request.id,
                method: request.method,
                _meta: request.params?._meta,
                ...(lifted.envelope !== undefined && { envelope: lifted.envelope }),
                ...(partitionedInputResponses !== undefined && { inputResponses: partitionedInputResponses.accepted }),
                ...(partitionedInputResponses !== undefined &&
                    partitionedInputResponses.droppedKeys.length > 0 && {
                        droppedInputResponseKeys: partitionedInputResponses.droppedKeys
                    }),
                ...(lifted.requestState !== undefined && { requestState: lifted.requestState }),
                signal: abortController.signal,
                // BaseContext.mcpReq.send is declared with two overloads (spec-method-keyed and explicit-schema). Arrow
                // literals can't carry overload signatures, so the inferred single-signature type isn't assignable to
                // that overloaded property type. The cast is sound: this impl dispatches both overload paths via the
                // isStandardSchema guard, and sendRequest validates the result against the resolved schema either way.
                send: ((r: Request, schemaOrOptions?: StandardSchemaV1 | RequestOptions, maybeOptions?: RequestOptions) => {
                    // Related requests resolve through the instance era at
                    // send time, exactly like direct sends: era-gate first,
                    // then method-keyed schema resolution.
                    const sendCodec = this._resolveOutboundCodec(r.method);
                    this._assertOutboundRequestInEra(sendCodec, r.method);
                    if (isStandardSchema(schemaOrOptions)) {
                        return sendRequest(r, schemaOrOptions, maybeOptions);
                    }
                    const resultSchema = sendCodec.resultSchema(r.method);
                    if (!resultSchema) {
                        throw new TypeError(
                            `'${r.method}' is not a spec method; pass a result schema as the second argument to ctx.mcpReq.send().`
                        );
                    }
                    return sendRequest(r, resultSchema, schemaOrOptions);
                }) as BaseContext['mcpReq']['send'],
                notify: sendNotification
            },
            http: extra?.authInfo ? { authInfo: extra.authInfo } : undefined
        };
        const ctx = this.buildContext(baseCtx, extra);

        // Starting with Promise.resolve() puts any synchronous errors into the monad as well.
        Promise.resolve()
            .then(() => handler(request, ctx))
            .then(
                async result => {
                    if (abortController.signal.aborted) {
                        // Request was cancelled
                        return;
                    }

                    // The outbound stamp seam: the era codec maps the neutral
                    // handler result to its wire shape. The 2025-era codec is
                    // the identity (never-stamp); the 2026-era codec stamps
                    // `resultType` and enforces the deleted-field set. A throw
                    // here is a NEW failure mode between handler success and
                    // the transport send (and the seam grows ttlMs/cacheScope
                    // stamping content in M3.2) — it must answer the peer with
                    // −32603 rather than stranding the request until timeout.
                    let encoded: Result;
                    try {
                        encoded = codec.encodeResult(request.method, result);
                    } catch (error) {
                        this._onerror(new Error(`Failed to encode result for ${request.method}: ${error}`));
                        sendErrorResponse(ProtocolErrorCode.InternalError, 'Internal error');
                        return;
                    }

                    const response: JSONRPCResponse = {
                        result: encoded,
                        jsonrpc: '2.0',
                        id: request.id
                    };
                    await capturedTransport?.send(response);
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
                    await capturedTransport?.send(errorResponse);
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

    /**
     * Inbound-response dispatch. Subclass overrides MUST delegate unmatched
     * traffic to `super._onresponse(response)` — an override that consumes
     * only what it owns and falls through to base dispatch for everything
     * else.
     */
    protected _onresponse(response: JSONRPCResponse | JSONRPCErrorResponse): void {
        const messageId = Number(response.id);

        const handler = this._responseHandlers.get(messageId);
        if (handler === undefined) {
            this._onerror(new Error(`Received a response for an unknown message ID: ${JSON.stringify(response)}`));
            return;
        }

        this._responseHandlers.delete(messageId);
        this._cleanupTimeout(messageId);
        this._progressHandlers.delete(messageId);

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
        const codec = this._resolveOutboundCodec(request.method);
        this._assertOutboundRequestInEra(codec, request.method);
        if (isStandardSchema(schemaOrOptions)) {
            return this._requestWithSchemaViaCodec(codec, request, schemaOrOptions, maybeOptions);
        }
        const resultSchema = codec.resultSchema(request.method);
        if (!resultSchema) {
            throw new TypeError(`'${request.method}' is not a spec method; pass a result schema as the second argument to request().`);
        }
        return this._requestWithSchemaViaCodec(codec, request, resultSchema, schemaOrOptions);
    }

    /**
     * The wire codec for this instance's negotiated era — the phase-2 truth:
     * everything an established connection sends and receives resolves
     * through it. Legacy until a version has been negotiated.
     */
    private _negotiatedWireCodec(): WireCodec {
        return codecForVersion(this._negotiatedProtocolVersion);
    }

    /**
     * Outbound codec resolution: while the negotiated version is still unset
     * (the negotiation window), lifecycle messages are bootstrap-pinned BY
     * METHOD — they self-identify their era (`initialize` IS the legacy
     * handshake, `server/discover` IS the modern probe). Once a version has
     * been negotiated, the instance era is authoritative for everything — a
     * negotiated session never re-routes a method onto the other era.
     */
    private _resolveOutboundCodec(method: string): WireCodec {
        if (this._negotiatedProtocolVersion === undefined) {
            const pinned = bootstrapOutboundCodec(method);
            if (pinned) return pinned;
        }
        return this._negotiatedWireCodec();
    }

    /**
     * Era gate for outbound requests — deletions are physical in BOTH
     * directions: sending a spec method that the resolved era does not define
     * dies locally with a typed error before anything reaches the transport.
     * Methods outside the spec universe are consumer-owned extension methods
     * and stay era-blind.
     */
    private _assertOutboundRequestInEra(codec: WireCodec, method: string): void {
        if (isSpecRequestMethod(method) && !codec.hasRequestMethod(method)) {
            throw new SdkError(
                SdkErrorCode.MethodNotSupportedByProtocolVersion,
                `Method '${method}' is not supported by the negotiated protocol version (wire era ${codec.era})`,
                { method, era: codec.era }
            );
        }
    }

    /**
     * Sends a request and waits for a response, using the provided schema for
     * validation instead of the era registry's method-keyed entry.
     *
     * This is the internal implementation used by SDK methods whose result
     * schema cannot be expressed as a method-keyed registry entry — the one
     * surviving case is `server.createMessage`, whose result schema depends
     * on the REQUEST params (tools vs no tools) — and by callers passing
     * explicit compatibility schemas. Spec methods are still era-gated here:
     * an explicit schema never smuggles a deleted method onto the wire.
     */
    protected _requestWithSchema<T extends StandardSchemaV1>(
        request: Request,
        resultSchema: T,
        options?: RequestOptions
    ): Promise<StandardSchemaV1.InferOutput<T>> {
        const codec = this._resolveOutboundCodec(request.method);
        this._assertOutboundRequestInEra(codec, request.method);
        return this._requestWithSchemaViaCodec(codec, request, resultSchema, options);
    }

    /**
     * The request funnel proper, keyed by the resolved era codec: the codec
     * owns result decoding (raw-first `resultType` discrimination — V-1 —
     * and the era's lift posture) before the schema validation step.
     */
    private _requestWithSchemaViaCodec<T extends StandardSchemaV1>(
        codec: WireCodec,
        request: Request,
        resultSchema: T,
        options?: RequestOptions
    ): Promise<StandardSchemaV1.InferOutput<T>> {
        const { relatedRequestId, resumptionToken, onresumptiontoken, headers } = options ?? {};
        // Flow start for non-complete result resolution: `maxTotalTimeout`
        // bounds the WHOLE flow, so the budget is measured from the original
        // request, not from when an extension takes over after the first leg.
        const flowStartedAt = Date.now();

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

            // Spec basic/patterns/cancellation §Transport-Specific (2026-07-28):
            // on Streamable HTTP, closing the per-request SSE stream IS the
            // cancellation signal — "no notifications/cancelled message is
            // required or expected". When the negotiated era is modern AND the
            // transport opens a per-request stream (`hasPerRequestStream`),
            // cancel() aborts that stream via `requestSignal` INSTEAD OF
            // POSTing `notifications/cancelled`. Every other (era × transport)
            // combination — legacy era on any transport, modern era on stdio /
            // in-memory — keeps today's `notifications/cancelled` POST path
            // unchanged.
            const streamCloseCancels = codec.era === MODERN_WIRE_REVISION && this._transport.hasPerRequestStream === true;
            const requestAbort = streamCloseCancels ? new AbortController() : undefined;

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

            // Per-request envelope auto-attach (after the progressToken merge so
            // both share the same `_meta`): a no-op on the legacy era — the
            // envelope seam returns undefined and the request goes out exactly as
            // built above.
            const outbound = this._envelopeOutbound(jsonrpcRequest);

            let responseReceived = false;

            const cancel = (reason: unknown) => {
                if (responseReceived) {
                    return;
                }
                this._progressHandlers.delete(messageId);

                if (requestAbort === undefined) {
                    this._transport
                        ?.send(
                            this._envelopeOutbound({
                                jsonrpc: '2.0',
                                method: 'notifications/cancelled',
                                params: {
                                    requestId: messageId,
                                    reason: String(reason)
                                }
                            }),
                            { relatedRequestId, resumptionToken, onresumptiontoken }
                        )
                        .catch(error => this._onerror(new Error(`Failed to send cancellation: ${error}`)));
                } else {
                    // Modern-era per-request-stream transport: aborting the
                    // request's underlying stream IS the spec cancel signal.
                    // The transport already swallows the resulting AbortError
                    // (no spurious `onerror`); a post-abort send() rejection
                    // re-hits an already-settled promise below and is a no-op.
                    requestAbort.abort();
                }

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

                // Codec decode hop — the structural V-1 home. The era codec
                // owns the raw-first resultType postures (Q1-SD3):
                // - 2026 era: REQUIRED discriminator; absent → typed error
                //   naming the spec violation; input_required → driver seam;
                //   unknown kind → invalid, no retry; complete → wire-exact
                //   parse then lift.
                // - 2025 era: resultType is foreign vocabulary → strip-on-
                //   lift, then today's schema validation decides.
                // Either way a non-complete body can never be masked into a
                // hollow success by a tolerant result schema.
                // Guarded: this callback runs synchronously inside
                // `_onresponse`, so a throw out of the decode hop would
                // otherwise propagate into the transport's onmessage instead
                // of failing this request.
                let decoded: ReturnType<WireCodec['decodeResult']>;
                try {
                    decoded = codec.decodeResult(request.method, response.result);
                } catch (error) {
                    return reject(error instanceof Error ? error : new Error(String(error)));
                }
                if (decoded.kind === 'invalid') {
                    return reject(decoded.error);
                }
                if (decoded.kind === 'input_required') {
                    // Manual mode (the primitive any driver layers over):
                    // hand the input-required value back to the caller.
                    if (options?.allowInputRequired === true) {
                        return resolve(manualInputRequiredValue(decoded) as StandardSchemaV1.InferOutput<T>);
                    }
                    // Non-complete result extension point: the role class may
                    // resolve the flow itself (the Client wires the
                    // multi-round-trip auto-fulfilment engine here). The base
                    // default is the typed UnsupportedResultType error.
                    const flow: NonCompleteResultFlow<T> = {
                        codec,
                        request,
                        resultSchema,
                        options,
                        flowStartedAt,
                        retry: (params, legOptions) =>
                            this._requestWithSchemaViaCodec(
                                codec,
                                params === undefined ? { method: request.method } : { method: request.method, params },
                                resultSchema,
                                legOptions
                            )
                    };
                    return resolve(this._resolveNonCompleteResult(decoded, flow) as Promise<StandardSchemaV1.InferOutput<T>>);
                }
                const result = decoded.result;

                validateStandardSchema(resultSchema, result).then(parseResult => {
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

            this._transport
                .send(outbound, { relatedRequestId, resumptionToken, onresumptiontoken, headers, requestSignal: requestAbort?.signal })
                .catch(error => {
                    this._progressHandlers.delete(messageId);
                    reject(error);
                });
        }).finally(() => {
            // Per-request cleanup that must run on every exit path. Consolidated
            // here so new exit paths added to the promise body can't forget it.
            // _progressHandlers is NOT cleaned up here: _onresponse deletes it
            // on resolution, and error paths above delete it inline.
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
        return this._notificationViaCodec(this._resolveOutboundCodec(notification.method), notification, options);
    }

    /**
     * The notification funnel proper, keyed by the resolved era codec —
     * direct sends and related notifications (`ctx.mcpReq.notify`) alike
     * resolve through the instance's negotiated era at send time.
     */
    private async _notificationViaCodec(codec: WireCodec, notification: Notification, options?: NotificationOptions): Promise<void> {
        if (!this._transport) {
            throw new SdkError(SdkErrorCode.NotConnected, 'Not connected');
        }

        // Era gate — outbound deletions are physical for notifications too: a
        // spec notification the resolved era does not define dies locally.
        if (isSpecNotificationMethod(notification.method) && !codec.hasNotificationMethod(notification.method)) {
            throw new SdkError(
                SdkErrorCode.MethodNotSupportedByProtocolVersion,
                `Notification '${notification.method}' is not supported by the negotiated protocol version (wire era ${codec.era})`,
                { method: notification.method, era: codec.era }
            );
        }

        this.assertNotificationCapability(notification.method);

        const jsonrpcNotification = this._envelopeOutbound({ jsonrpc: '2.0' as const, ...notification });

        const debouncedMethods = this._options?.debouncedNotificationMethods ?? [];
        // A notification can only be debounced if it's in the list AND it's "simple"
        // (i.e., has no parameters and no related request ID that could be lost).
        const canDebounce = debouncedMethods.includes(notification.method) && !notification.params && !options?.relatedRequestId;

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
                this._transport?.send(jsonrpcNotification, options).catch(error => this._onerror(error));
            });

            // Return immediately.
            return;
        }

        await this._transport.send(jsonrpcNotification, options);
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
        handler: (request: RequestTypeMap[M], ctx: ContextT) => HandlerResultTypeMap[M] | Promise<HandlerResultTypeMap[M]>
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
            if (!isSpecRequestMethod(method)) {
                throw new TypeError(
                    `'${method}' is not a spec request method; pass schemas as the second argument to setRequestHandler().`
                );
            }
            // Dispatch-time schema resolution: the request is parsed with the
            // schema of the era serving this connection (the instance era at
            // dispatch time), never with a schema captured at registration
            // time. On the 2026-07-28 era the demoted server→client methods
            // (elicitation/sampling/roots) are not wire request methods —
            // they reach a handler only as embedded input requests dispatched
            // by the multi-round-trip driver, and parse with the era's
            // in-band schema instead.
            stored = (request, ctx) => {
                const dispatchCodec = this._negotiatedWireCodec();
                const schema = dispatchCodec.requestSchema(method) ?? dispatchCodec.inputRequestSchema(method);
                if (!schema) {
                    // Unreachable: the dispatch era gate rejects era-mismatched
                    // spec methods with −32601 before any handler runs.
                    throw new ProtocolError(ProtocolErrorCode.InternalError, `No wire schema for ${method} in the resolved era`);
                }
                return Promise.resolve(schemasOrHandler(schema.parse(request), ctx));
            };
        } else if (maybeHandler) {
            stored = async (request, ctx) => {
                // Custom handlers receive `_meta` present-minus-reserved: the
                // wire-only lift already removed the reserved envelope keys,
                // and the remaining metadata (progressToken, extension keys)
                // is handler material — consistent with the spec-method path.
                // (Behavior migration: `_meta` used to be deleted here.)
                const parsed = await validateStandardSchema(schemasOrHandler.params, { ...request.params });
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
     * argument; `_meta` is recoverable via `notification.params?._meta` (minus the
     * reserved `io.modelcontextprotocol/*` envelope keys, which the protocol layer
     * lifts out before dispatch).
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
            if (!isSpecNotificationMethod(method)) {
                throw new TypeError(
                    `'${method}' is not a spec notification method; pass schemas as the second argument to setNotificationHandler().`
                );
            }
            // Dispatch-time schema resolution, same as setRequestHandler: the
            // era serving the message picks the schema.
            this._notificationHandlers.set(method, (notification, codec) => {
                const schema = codec.notificationSchema(method);
                if (!schema) {
                    // Unreachable: the dispatch era gate drops era-mismatched
                    // spec notifications before any handler runs.
                    throw new ProtocolError(ProtocolErrorCode.InternalError, `No wire schema for ${method} in the resolved era`);
                }
                return Promise.resolve(schemasOrHandler(schema.parse(notification)));
            });
            return;
        }

        if (!maybeHandler) {
            throw new TypeError('setNotificationHandler: handler is required');
        }
        this._notificationHandlers.set(method, async notification => {
            // `_meta` present-minus-reserved, matching the custom request
            // path (the lift already removed the reserved envelope keys).
            const parsed = await validateStandardSchema(schemasOrHandler.params, { ...notification.params });
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
