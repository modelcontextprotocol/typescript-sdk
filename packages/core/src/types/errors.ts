import { ProtocolErrorCode } from './enums.js';
import type {
    ClientCapabilities,
    ElicitRequestURLParams,
    MissingRequiredClientCapabilityErrorData,
    UnsupportedProtocolVersionErrorData
} from './types.js';

/**
 * Protocol errors are JSON-RPC errors that cross the wire as error responses.
 * They use numeric error codes from the {@linkcode ProtocolErrorCode} enum.
 */
export class ProtocolError extends Error {
    constructor(
        public readonly code: number,
        message: string,
        public readonly data?: unknown
    ) {
        super(message);
        this.name = 'ProtocolError';
    }

    /**
     * Factory method to create the appropriate error type based on the error code and data
     */
    static fromError(code: number, message: string, data?: unknown): ProtocolError {
        // Check for specific error types
        if (code === ProtocolErrorCode.UrlElicitationRequired && data) {
            const errorData = data as { elicitations?: unknown[] };
            if (errorData.elicitations) {
                return new UrlElicitationRequiredError(errorData.elicitations as ElicitRequestURLParams[], message);
            }
        }

        if (code === ProtocolErrorCode.UnsupportedProtocolVersion && data) {
            const errorData = data as Partial<UnsupportedProtocolVersionErrorData>;
            if (Array.isArray(errorData.supported) && typeof errorData.requested === 'string') {
                return new UnsupportedProtocolVersionError({ supported: errorData.supported, requested: errorData.requested }, message);
            }
        }

        if (code === ProtocolErrorCode.MissingRequiredClientCapability && data) {
            const errorData = data as Partial<MissingRequiredClientCapabilityErrorData>;
            if (
                errorData.requiredCapabilities !== null &&
                typeof errorData.requiredCapabilities === 'object' &&
                !Array.isArray(errorData.requiredCapabilities)
            ) {
                return new MissingRequiredClientCapabilityError({ requiredCapabilities: errorData.requiredCapabilities }, message);
            }
        }

        // Default to generic ProtocolError
        return new ProtocolError(code, message, data);
    }
}

/**
 * Specialized error type when a tool requires a URL mode elicitation.
 * This makes it nicer for the client to handle since there is specific data to work with instead of just a code to check against.
 */
export class UrlElicitationRequiredError extends ProtocolError {
    constructor(elicitations: ElicitRequestURLParams[], message: string = `URL elicitation${elicitations.length > 1 ? 's' : ''} required`) {
        super(ProtocolErrorCode.UrlElicitationRequired, message, {
            elicitations: elicitations
        });
    }

    get elicitations(): ElicitRequestURLParams[] {
        return (this.data as { elicitations: ElicitRequestURLParams[] })?.elicitations ?? [];
    }
}

/**
 * Error type for the `-32004` UnsupportedProtocolVersion protocol error (protocol
 * revision 2026-07-28): the request's protocol version is unknown to the server or
 * unsupported by it.
 *
 * The error data lists the protocol versions the receiver supports (`supported`),
 * so the sender can choose a mutually supported version and retry, and echoes the
 * version that was requested (`requested`).
 */
export class UnsupportedProtocolVersionError extends ProtocolError {
    constructor(data: UnsupportedProtocolVersionErrorData, message: string = `Unsupported protocol version: ${data.requested}`) {
        super(ProtocolErrorCode.UnsupportedProtocolVersion, message, data);
    }

    /**
     * Protocol versions the receiver supports.
     */
    get supported(): string[] {
        return (this.data as UnsupportedProtocolVersionErrorData).supported;
    }

    /**
     * The protocol version that was requested.
     */
    get requested(): string {
        return (this.data as UnsupportedProtocolVersionErrorData).requested;
    }
}

/**
 * Error type for the `-32003` MissingRequiredClientCapability protocol error
 * (protocol revision 2026-07-28): processing the request requires a capability
 * the client did not declare in the request's `clientCapabilities`.
 *
 * The error data lists the missing capabilities (`requiredCapabilities`) in
 * the `ClientCapabilities` shape, so the client can see exactly what it would
 * have to declare for the request to be served. On HTTP, the response status
 * is `400 Bad Request`.
 *
 * Recognize this error by its code and `data.requiredCapabilities` rather than
 * by class identity (`instanceof` does not work across separately bundled
 * copies of the SDK).
 */
export class MissingRequiredClientCapabilityError extends ProtocolError {
    constructor(
        data: MissingRequiredClientCapabilityErrorData,
        message: string = `Missing required client capabilities: ${Object.keys(data.requiredCapabilities).join(', ')}`
    ) {
        super(ProtocolErrorCode.MissingRequiredClientCapability, message, data);
    }

    /**
     * The capabilities the server requires from the client to process the
     * request (only the missing capabilities are listed).
     */
    get requiredCapabilities(): ClientCapabilities {
        return (this.data as MissingRequiredClientCapabilityErrorData).requiredCapabilities;
    }
}
