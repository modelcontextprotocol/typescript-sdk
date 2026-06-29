/**
 * Error codes for SDK errors (local errors that never cross the wire).
 * Unlike {@linkcode ProtocolErrorCode} which uses numeric JSON-RPC codes, `SdkErrorCode` uses
 * descriptive string values for better developer experience.
 *
 * These errors are thrown locally by the SDK and are never serialized as
 * JSON-RPC error responses.
 */
export enum SdkErrorCode {
    // State errors
    /** Transport is not connected */
    NotConnected = 'NOT_CONNECTED',
    /** Transport is already connected */
    AlreadyConnected = 'ALREADY_CONNECTED',
    /** Protocol is not initialized */
    NotInitialized = 'NOT_INITIALIZED',

    // Capability errors
    /** Required capability is not supported by the remote side */
    CapabilityNotSupported = 'CAPABILITY_NOT_SUPPORTED',

    // Transport errors
    /** Request timed out waiting for response */
    RequestTimeout = 'REQUEST_TIMEOUT',
    /** Connection was closed */
    ConnectionClosed = 'CONNECTION_CLOSED',
    /** Failed to send message */
    SendFailed = 'SEND_FAILED',
    /** Response result failed local schema validation */
    InvalidResult = 'INVALID_RESULT',
    /**
     * The response carried a `resultType` discriminator (protocol revision
     * 2026-07-28) naming a result kind this client cannot consume yet, e.g.
     * `input_required`. The kind is carried in `data.resultType`.
     */
    UnsupportedResultType = 'UNSUPPORTED_RESULT_TYPE',
    /**
     * The multi-round-trip auto-fulfilment driver exhausted its round cap
     * (`inputRequired.maxRounds`) without the server returning a complete
     * result. `data.rounds` carries the cap that was hit and
     * `data.lastResult` carries the last `input_required` payload received
     * (`{ inputRequests, requestState? }`), so callers can inspect or resume
     * the flow manually.
     */
    InputRequiredRoundsExceeded = 'INPUT_REQUIRED_ROUNDS_EXCEEDED',
    /**
     * The auto-aggregating no-`cursor` `listTools()` / `listPrompts()` /
     * `listResources()` / `listResourceTemplates()` walk hit the
     * `ClientOptions.listMaxPages` cap without the server's pagination
     * converging. `data.method` carries the list verb and
     * `data.listMaxPages` the cap that was hit; raise the cap or fall back to
     * explicit per-page `{ cursor }` calls.
     */
    ListPaginationExceeded = 'LIST_PAGINATION_EXCEEDED',
    /**
     * The spec method being sent does not exist on the negotiated protocol
     * version's wire era (e.g. `tasks/get` toward a 2026-07-28 peer, or
     * `server/discover` toward a 2025-era peer). Raised locally, before
     * anything reaches the transport. The method and era are carried in
     * `data.method` / `data.era`.
     */
    MethodNotSupportedByProtocolVersion = 'METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION',
    /**
     * Protocol-era negotiation at connect time failed without producing either a
     * usable modern (2026-07-28+) era or a definitive legacy fallback signal —
     * e.g. the negotiation mode forbids falling back (`pin`), or the probe hit a
     * network failure (a typed connect error, never an era verdict).
     *
     * Negotiation-phase only: this code is never used once an era is established.
     */
    EraNegotiationFailed = 'ERA_NEGOTIATION_FAILED',

    // Transport errors
    ClientHttpNotImplemented = 'CLIENT_HTTP_NOT_IMPLEMENTED',
    ClientHttpAuthentication = 'CLIENT_HTTP_AUTHENTICATION',
    ClientHttpForbidden = 'CLIENT_HTTP_FORBIDDEN',
    ClientHttpUnexpectedContent = 'CLIENT_HTTP_UNEXPECTED_CONTENT',
    ClientHttpFailedToOpenStream = 'CLIENT_HTTP_FAILED_TO_OPEN_STREAM',
    ClientHttpFailedToTerminateSession = 'CLIENT_HTTP_FAILED_TO_TERMINATE_SESSION'
}

/**
 * SDK errors are local errors that never cross the wire.
 * They are distinct from {@linkcode ProtocolError} which represents JSON-RPC protocol errors
 * that are serialized and sent as error responses.
 *
 * @example
 * ```ts source="./sdkErrors.examples.ts#SdkError_basicUsage"
 * try {
 *     // Throwing an SDK error
 *     throw new SdkError(SdkErrorCode.NotConnected, 'Transport is not connected');
 * } catch (error) {
 *     // Checking error type by code
 *     if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) {
 *         // Handle timeout
 *     }
 * }
 * ```
 */
export class SdkError extends Error {
    constructor(
        public readonly code: SdkErrorCode,
        message: string,
        public readonly data?: unknown
    ) {
        super(message);
        this.name = 'SdkError';
    }
}

/**
 * Typed shape for HTTP error data carried by {@linkcode SdkHttpError}.
 */
export interface SdkHttpErrorData {
    status: number;
    statusText?: string;
    [key: string]: unknown;
}

/**
 * An {@linkcode SdkError} subclass for HTTP transport failures.
 *
 * Thrown by the streamable HTTP transport when the server responds with a
 * non-OK status code. Narrows {@linkcode SdkError.data | data} to
 * {@linkcode SdkHttpErrorData} so consumers can inspect the HTTP status
 * without unsafe casting.
 *
 * @example
 * ```ts source="./sdkErrors.examples.ts#SdkHttpError_basicUsage"
 * if (error instanceof SdkHttpError) {
 *     console.log(error.status); // number
 *     console.log(error.statusText); // string | undefined
 * }
 * ```
 */
export class SdkHttpError extends SdkError {
    declare readonly data: SdkHttpErrorData;

    constructor(code: SdkErrorCode, message: string, data: SdkHttpErrorData) {
        super(code, message, data);
        this.name = 'SdkHttpError';
    }

    get status(): number {
        return this.data.status;
    }

    get statusText(): string | undefined {
        return this.data.statusText;
    }
}
