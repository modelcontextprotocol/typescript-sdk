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
 * ```typescript
 * // Throwing an SDK error
 * throw new SdkError(SdkErrorCode.NotConnected, 'Transport is not connected');
 *
 * // Checking error type by code
 * if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) {
 *     // Handle timeout
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
