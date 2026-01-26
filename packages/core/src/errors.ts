/**
 * MCP SDK Error Hierarchy
 *
 * This module defines a comprehensive error hierarchy for the MCP SDK:
 *
 * 1. Protocol Errors - Errors that cross the wire as JSON-RPC errors
 *    - ProtocolError: Protocol-level errors with locked codes
 *    - Users can throw ProtocolError for intentional locked-code errors
 *    - Other errors thrown by users are customizable via onError handler
 *
 * 2. SDK Errors (SdkError subclasses) - Local errors that don't cross the wire
 *    - StateError: Wrong SDK state (not connected, already connected, etc.)
 *    - CapabilityError: Missing required capability
 *    - TransportError: Network/connection issues
 *    - ValidationError: Local schema validation issues
 *
 * 3. OAuth Errors - Kept in auth/errors.ts (unchanged)
 */

import type { ElicitRequestURLParams } from './types/types.js';
import { ErrorCode } from './types/types.js';

// ═══════════════════════════════════════════════════════════════════════════
// SDK Error Codes (for local errors that don't cross the wire)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Error codes for local SDK errors (not transmitted over JSON-RPC)
 */
export enum SdkErrorCode {
    // State errors
    NOT_CONNECTED = 'NOT_CONNECTED',
    ALREADY_CONNECTED = 'ALREADY_CONNECTED',
    INVALID_STATE = 'INVALID_STATE',
    REGISTRATION_AFTER_CONNECT = 'REGISTRATION_AFTER_CONNECT',

    // Capability errors
    CAPABILITY_NOT_SUPPORTED = 'CAPABILITY_NOT_SUPPORTED',

    // Transport errors
    CONNECTION_FAILED = 'CONNECTION_FAILED',
    CONNECTION_LOST = 'CONNECTION_LOST',
    CONNECTION_TIMEOUT = 'CONNECTION_TIMEOUT',
    SEND_FAILED = 'SEND_FAILED',

    // Validation errors
    INVALID_SCHEMA = 'INVALID_SCHEMA',
    INVALID_REQUEST = 'INVALID_REQUEST',
    INVALID_RESPONSE = 'INVALID_RESPONSE'
}

// ═══════════════════════════════════════════════════════════════════════════
// Protocol Errors (cross the wire as JSON-RPC errors)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Protocol-level errors that cross the wire as JSON-RPC errors.
 * The error code is LOCKED and cannot be changed in onProtocolError handlers.
 *
 * Use this when you want a specific error code that should not be customized:
 * - SDK uses this for spec-mandated errors (parse error, method not found, etc.)
 * - Users can throw this for intentional locked-code errors
 *
 * For errors where you want the onError handler to customize the response,
 * throw a plain Error instead.
 */
export class ProtocolError extends Error {
    /**
     * Indicates this is a protocol-level error with a locked code
     */
    readonly isProtocolLevel = true as const;

    constructor(
        public readonly code: number,
        message: string,
        public readonly data?: unknown
    ) {
        super(`MCP error ${code}: ${message}`);
        this.name = 'ProtocolError';
    }

    /**
     * Creates a parse error (-32700)
     */
    static parseError(message: string = 'Parse error', data?: unknown): ProtocolError {
        return new ProtocolError(ErrorCode.ParseError, message, data);
    }

    /**
     * Creates an invalid request error (-32600)
     */
    static invalidRequest(message: string = 'Invalid request', data?: unknown): ProtocolError {
        return new ProtocolError(ErrorCode.InvalidRequest, message, data);
    }

    /**
     * Creates a method not found error (-32601)
     */
    static methodNotFound(method: string, data?: unknown): ProtocolError {
        return new ProtocolError(ErrorCode.MethodNotFound, `Method not found: ${method}`, data);
    }

    /**
     * Creates an invalid params error (-32602)
     */
    static invalidParams(message: string = 'Invalid params', data?: unknown): ProtocolError {
        return new ProtocolError(ErrorCode.InvalidParams, message, data);
    }

    /**
     * Creates an internal error (-32603)
     */
    static internalError(message: string = 'Internal error', data?: unknown): ProtocolError {
        return new ProtocolError(ErrorCode.InternalError, message, data);
    }

    /**
     * Factory method to create the appropriate error type based on the error code and data
     */
    static fromError(code: number, message: string, data?: unknown): ProtocolError {
        // Check for specific error types
        if (code === ErrorCode.UrlElicitationRequired && data) {
            const errorData = data as { elicitations?: unknown[] };
            if (errorData.elicitations) {
                return new UrlElicitationRequiredError(errorData.elicitations as ElicitRequestURLParams[], message);
            }
        }

        // Default to generic ProtocolError
        return new ProtocolError(code, message, data);
    }
}

/**
 * Specialized error type when a tool requires a URL mode elicitation.
 * This makes it nicer for the client to handle since there is specific data to work with.
 */
export class UrlElicitationRequiredError extends ProtocolError {
    constructor(elicitations: ElicitRequestURLParams[], message: string = `URL elicitation${elicitations.length > 1 ? 's' : ''} required`) {
        super(ErrorCode.UrlElicitationRequired, message, {
            elicitations: elicitations
        });
        this.name = 'UrlElicitationRequiredError';
    }

    get elicitations(): ElicitRequestURLParams[] {
        return (this.data as { elicitations: ElicitRequestURLParams[] })?.elicitations ?? [];
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// SDK Error Hierarchy (local errors - don't cross the wire)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Base class for local SDK errors that don't cross the wire.
 * These are thrown locally and should be caught by the SDK user.
 */
export abstract class SdkError extends Error {
    /**
     * The SDK error code for programmatic handling
     */
    abstract readonly code: SdkErrorCode;

    /**
     * Whether this error is potentially recoverable
     */
    readonly recoverable: boolean = false;

    constructor(message: string) {
        super(message);
        this.name = this.constructor.name;
    }
}

/**
 * Errors related to incorrect SDK state.
 * Examples: "Not connected", "Already connected", "Cannot register after connecting"
 */
export class StateError extends SdkError {
    readonly code: SdkErrorCode;

    constructor(
        code:
            | SdkErrorCode.NOT_CONNECTED
            | SdkErrorCode.ALREADY_CONNECTED
            | SdkErrorCode.INVALID_STATE
            | SdkErrorCode.REGISTRATION_AFTER_CONNECT,
        message: string
    ) {
        super(message);
        this.code = code;
    }

    /**
     * Creates a "not connected" error
     */
    static notConnected(operation: string = 'perform this operation'): StateError {
        return new StateError(SdkErrorCode.NOT_CONNECTED, `Cannot ${operation}: not connected`);
    }

    /**
     * Creates an "already connected" error
     */
    static alreadyConnected(): StateError {
        return new StateError(SdkErrorCode.ALREADY_CONNECTED, 'Already connected');
    }

    /**
     * Creates an "invalid state" error
     */
    static invalidState(message: string): StateError {
        return new StateError(SdkErrorCode.INVALID_STATE, message);
    }

    /**
     * Creates a "registration after connect" error
     */
    static registrationAfterConnect(type: string): StateError {
        return new StateError(SdkErrorCode.REGISTRATION_AFTER_CONNECT, `Cannot register ${type} after connecting`);
    }
}

/**
 * Errors related to missing or unsupported capabilities.
 * Example: "Server does not support X (required for Y)"
 */
export class CapabilityError extends SdkError {
    readonly code = SdkErrorCode.CAPABILITY_NOT_SUPPORTED as const;

    constructor(
        public readonly capability: string,
        public readonly requiredFor?: string
    ) {
        const message = requiredFor
            ? `Capability '${capability}' is not supported (required for ${requiredFor})`
            : `Capability '${capability}' is not supported`;
        super(message);
    }

    /**
     * Creates a capability error for a missing server capability
     */
    static serverDoesNotSupport(capability: string, requiredFor?: string): CapabilityError {
        return new CapabilityError(capability, requiredFor);
    }

    /**
     * Creates a capability error for a missing client capability
     */
    static clientDoesNotSupport(capability: string, requiredFor?: string): CapabilityError {
        return new CapabilityError(capability, requiredFor);
    }
}

/**
 * Errors related to transport/network issues.
 * Examples: Connection failed, timeout, connection lost
 */
export class TransportError extends SdkError {
    readonly code: SdkErrorCode;
    override readonly recoverable: boolean;

    constructor(
        code: SdkErrorCode.CONNECTION_FAILED | SdkErrorCode.CONNECTION_LOST | SdkErrorCode.CONNECTION_TIMEOUT | SdkErrorCode.SEND_FAILED,
        message: string,
        public override readonly cause?: Error
    ) {
        super(message);
        this.code = code;
        // Connection lost and timeout are potentially recoverable via retry
        this.recoverable = code === SdkErrorCode.CONNECTION_LOST || code === SdkErrorCode.CONNECTION_TIMEOUT;
    }

    /**
     * Creates a connection failed error
     */
    static connectionFailed(message: string = 'Connection failed', cause?: Error): TransportError {
        return new TransportError(SdkErrorCode.CONNECTION_FAILED, message, cause);
    }

    /**
     * Creates a connection lost error
     */
    static connectionLost(message: string = 'Connection lost', cause?: Error): TransportError {
        const error = new TransportError(SdkErrorCode.CONNECTION_LOST, message, cause);
        return error;
    }

    /**
     * Creates a connection timeout error
     */
    static connectionTimeout(timeoutMs: number, cause?: Error): TransportError {
        return new TransportError(SdkErrorCode.CONNECTION_TIMEOUT, `Connection timed out after ${timeoutMs}ms`, cause);
    }

    /**
     * Creates a request timeout error (request sent but no response received in time)
     */
    static requestTimeout(
        message: string = 'Request timed out',
        details?: { timeout?: number; maxTotalTimeout?: number; totalElapsed?: number }
    ): TransportError {
        const detailsStr = details ? ` (${JSON.stringify(details)})` : '';
        return new TransportError(SdkErrorCode.CONNECTION_TIMEOUT, `${message}${detailsStr}`);
    }

    /**
     * Creates a send failed error
     */
    static sendFailed(message: string = 'Failed to send message', cause?: Error): TransportError {
        return new TransportError(SdkErrorCode.SEND_FAILED, message, cause);
    }

    /**
     * Creates a connection closed error
     */
    static connectionClosed(message: string = 'Connection closed'): TransportError {
        return new TransportError(SdkErrorCode.CONNECTION_LOST, message);
    }
}

/**
 * Errors related to local schema/validation issues (before sending).
 * Examples: "Schema is missing a method literal", "Invalid request format"
 */
export class ValidationError extends SdkError {
    readonly code: SdkErrorCode;

    constructor(
        code: SdkErrorCode.INVALID_SCHEMA | SdkErrorCode.INVALID_REQUEST | SdkErrorCode.INVALID_RESPONSE,
        message: string,
        public readonly details?: unknown
    ) {
        super(message);
        this.code = code;
    }

    /**
     * Creates an invalid schema error
     */
    static invalidSchema(message: string, details?: unknown): ValidationError {
        return new ValidationError(SdkErrorCode.INVALID_SCHEMA, message, details);
    }

    /**
     * Creates an invalid request error (local validation)
     */
    static invalidRequest(message: string, details?: unknown): ValidationError {
        return new ValidationError(SdkErrorCode.INVALID_REQUEST, message, details);
    }

    /**
     * Creates an invalid response error (local validation)
     */
    static invalidResponse(message: string, details?: unknown): ValidationError {
        return new ValidationError(SdkErrorCode.INVALID_RESPONSE, message, details);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Type Guards
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Type guard to check if an error is a ProtocolError
 */
export function isProtocolError(error: unknown): error is ProtocolError {
    return error instanceof ProtocolError;
}

/**
 * Type guard to check if an error is an SdkError
 */
export function isSdkError(error: unknown): error is SdkError {
    return error instanceof SdkError;
}

/**
 * Type guard to check if an error is a StateError
 */
export function isStateError(error: unknown): error is StateError {
    return error instanceof StateError;
}

/**
 * Type guard to check if an error is a CapabilityError
 */
export function isCapabilityError(error: unknown): error is CapabilityError {
    return error instanceof CapabilityError;
}

/**
 * Type guard to check if an error is a TransportError
 */
export function isTransportError(error: unknown): error is TransportError {
    return error instanceof TransportError;
}

/**
 * Type guard to check if an error is a ValidationError
 */
export function isValidationError(error: unknown): error is ValidationError {
    return error instanceof ValidationError;
}
