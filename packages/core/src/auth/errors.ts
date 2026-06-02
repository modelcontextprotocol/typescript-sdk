import type { OAuthErrorResponse } from '../shared/auth.js';

/**
 * OAuth error codes as defined by {@link https://datatracker.ietf.org/doc/html/rfc6749#section-5.2 | RFC 6749}
 * and extensions.
 */
export enum OAuthErrorCode {
    /**
     * The request is missing a required parameter, includes an invalid parameter value,
     * includes a parameter more than once, or is otherwise malformed.
     */
    InvalidRequest = 'invalid_request',

    /**
     * Client authentication failed (e.g., unknown client, no client authentication included,
     * or unsupported authentication method).
     */
    InvalidClient = 'invalid_client',

    /**
     * The provided authorization grant or refresh token is invalid, expired, revoked,
     * does not match the redirection URI used in the authorization request, or was issued to another client.
     */
    InvalidGrant = 'invalid_grant',

    /**
     * The authenticated client is not authorized to use this authorization grant type.
     */
    UnauthorizedClient = 'unauthorized_client',

    /**
     * The authorization grant type is not supported by the authorization server.
     */
    UnsupportedGrantType = 'unsupported_grant_type',

    /**
     * The requested scope is invalid, unknown, malformed, or exceeds the scope granted by the resource owner.
     */
    InvalidScope = 'invalid_scope',

    /**
     * The resource owner or authorization server denied the request.
     */
    AccessDenied = 'access_denied',

    /**
     * The authorization server encountered an unexpected condition that prevented it from fulfilling the request.
     */
    ServerError = 'server_error',

    /**
     * The authorization server is currently unable to handle the request due to temporary overloading or maintenance.
     */
    TemporarilyUnavailable = 'temporarily_unavailable',

    /**
     * The authorization server does not support obtaining an authorization code using this method.
     */
    UnsupportedResponseType = 'unsupported_response_type',

    /**
     * The authorization server does not support the requested token type.
     */
    UnsupportedTokenType = 'unsupported_token_type',

    /**
     * The access token provided is expired, revoked, malformed, or invalid for other reasons.
     */
    InvalidToken = 'invalid_token',

    /**
     * The HTTP method used is not allowed for this endpoint. (Custom, non-standard error)
     */
    MethodNotAllowed = 'method_not_allowed',

    /**
     * Rate limit exceeded. (Custom, non-standard error based on RFC 6585)
     */
    TooManyRequests = 'too_many_requests',

    /**
     * The client metadata is invalid. (Custom error for dynamic client registration - RFC 7591)
     */
    InvalidClientMetadata = 'invalid_client_metadata',

    /**
     * The request requires higher privileges than provided by the access token.
     */
    InsufficientScope = 'insufficient_scope',

    /**
     * The requested resource is invalid, missing, unknown, or malformed. (Custom error for resource indicators - RFC 8707)
     */
    InvalidTarget = 'invalid_target'
}

/**
 * OAuth error class for all OAuth-related errors.
 */
export class OAuthError extends Error {
    constructor(
        public readonly code: OAuthErrorCode | string,
        message: string,
        public readonly errorUri?: string
    ) {
        super(message);
        this.name = 'OAuthError';
    }

    /**
     * The OAuth error code.
     *
     * @deprecated Use {@linkcode OAuthError.code} instead. Provided for compatibility with
     * SDK 1.x, where the error code was exposed as `errorCode`.
     */
    get errorCode(): string {
        return this.code;
    }

    /**
     * Converts the error to a standard OAuth error response object.
     */
    toResponseObject(): OAuthErrorResponse {
        const response: OAuthErrorResponse = {
            error: this.code,
            error_description: this.message
        };

        if (this.errorUri) {
            response.error_uri = this.errorUri;
        }

        return response;
    }

    /**
     * Creates an {@linkcode OAuthError} from an OAuth error response.
     *
     * Returns the specific subclass for known error codes (e.g. {@linkcode InvalidGrantError}
     * for `invalid_grant`), so `instanceof` checks written against SDK 1.x keep working.
     */
    static fromResponse(response: OAuthErrorResponse): OAuthError {
        return oauthErrorFromCode(response.error, response.error_description ?? response.error, response.error_uri);
    }
}

/**
 * Base shape shared by the deprecated SDK 1.x error subclasses below.
 *
 * In SDK 1.x every OAuth error code had its own `OAuthError` subclass and consumers
 * classified errors with `instanceof` (e.g. `error instanceof InvalidGrantError` to drop
 * stored tokens, `error instanceof ServerError` to retry). These subclasses are preserved
 * so that classification keeps working after migrating to 2.x.
 *
 * Note: unlike 1.x, `error.name` is `'OAuthError'` for all subclasses, matching the 2.x
 * base class. Code that needs the specific kind should check `error.code` or `instanceof`.
 */
type OAuthErrorSubclass = new (message: string, errorUri?: string) => OAuthError;

/**
 * The one 1.x OAuth error class that could not keep its original name: 2.x already exports a
 * JSON-RPC `InvalidRequestError` interface from the protocol types. Code migrating from 1.x
 * that checked `error instanceof InvalidRequestError` (uncommon in clients — this error is
 * produced by request validation on the server side) should check
 * `error.code === OAuthErrorCode.InvalidRequest` instead.
 *
 * @deprecated Use {@linkcode OAuthError} and check `code === OAuthErrorCode.InvalidRequest`.
 */
export class OAuthInvalidRequestError extends OAuthError {
    constructor(message: string, errorUri?: string) {
        super(OAuthErrorCode.InvalidRequest, message, errorUri);
    }
}

/** @deprecated Use {@linkcode OAuthError} and check `code === OAuthErrorCode.InvalidClient`. */
export class InvalidClientError extends OAuthError {
    constructor(message: string, errorUri?: string) {
        super(OAuthErrorCode.InvalidClient, message, errorUri);
    }
}

/** @deprecated Use {@linkcode OAuthError} and check `code === OAuthErrorCode.InvalidGrant`. */
export class InvalidGrantError extends OAuthError {
    constructor(message: string, errorUri?: string) {
        super(OAuthErrorCode.InvalidGrant, message, errorUri);
    }
}

/** @deprecated Use {@linkcode OAuthError} and check `code === OAuthErrorCode.UnauthorizedClient`. */
export class UnauthorizedClientError extends OAuthError {
    constructor(message: string, errorUri?: string) {
        super(OAuthErrorCode.UnauthorizedClient, message, errorUri);
    }
}

/** @deprecated Use {@linkcode OAuthError} and check `code === OAuthErrorCode.UnsupportedGrantType`. */
export class UnsupportedGrantTypeError extends OAuthError {
    constructor(message: string, errorUri?: string) {
        super(OAuthErrorCode.UnsupportedGrantType, message, errorUri);
    }
}

/** @deprecated Use {@linkcode OAuthError} and check `code === OAuthErrorCode.InvalidScope`. */
export class InvalidScopeError extends OAuthError {
    constructor(message: string, errorUri?: string) {
        super(OAuthErrorCode.InvalidScope, message, errorUri);
    }
}

/** @deprecated Use {@linkcode OAuthError} and check `code === OAuthErrorCode.AccessDenied`. */
export class AccessDeniedError extends OAuthError {
    constructor(message: string, errorUri?: string) {
        super(OAuthErrorCode.AccessDenied, message, errorUri);
    }
}

/** @deprecated Use {@linkcode OAuthError} and check `code === OAuthErrorCode.ServerError`. */
export class ServerError extends OAuthError {
    constructor(message: string, errorUri?: string) {
        super(OAuthErrorCode.ServerError, message, errorUri);
    }
}

/** @deprecated Use {@linkcode OAuthError} and check `code === OAuthErrorCode.TemporarilyUnavailable`. */
export class TemporarilyUnavailableError extends OAuthError {
    constructor(message: string, errorUri?: string) {
        super(OAuthErrorCode.TemporarilyUnavailable, message, errorUri);
    }
}

/** @deprecated Use {@linkcode OAuthError} and check `code === OAuthErrorCode.UnsupportedResponseType`. */
export class UnsupportedResponseTypeError extends OAuthError {
    constructor(message: string, errorUri?: string) {
        super(OAuthErrorCode.UnsupportedResponseType, message, errorUri);
    }
}

/** @deprecated Use {@linkcode OAuthError} and check `code === OAuthErrorCode.UnsupportedTokenType`. */
export class UnsupportedTokenTypeError extends OAuthError {
    constructor(message: string, errorUri?: string) {
        super(OAuthErrorCode.UnsupportedTokenType, message, errorUri);
    }
}

/** @deprecated Use {@linkcode OAuthError} and check `code === OAuthErrorCode.InvalidToken`. */
export class InvalidTokenError extends OAuthError {
    constructor(message: string, errorUri?: string) {
        super(OAuthErrorCode.InvalidToken, message, errorUri);
    }
}

/** @deprecated Use {@linkcode OAuthError} and check `code === OAuthErrorCode.MethodNotAllowed`. */
export class MethodNotAllowedError extends OAuthError {
    constructor(message: string, errorUri?: string) {
        super(OAuthErrorCode.MethodNotAllowed, message, errorUri);
    }
}

/** @deprecated Use {@linkcode OAuthError} and check `code === OAuthErrorCode.TooManyRequests`. */
export class TooManyRequestsError extends OAuthError {
    constructor(message: string, errorUri?: string) {
        super(OAuthErrorCode.TooManyRequests, message, errorUri);
    }
}

/** @deprecated Use {@linkcode OAuthError} and check `code === OAuthErrorCode.InvalidClientMetadata`. */
export class InvalidClientMetadataError extends OAuthError {
    constructor(message: string, errorUri?: string) {
        super(OAuthErrorCode.InvalidClientMetadata, message, errorUri);
    }
}

/** @deprecated Use {@linkcode OAuthError} and check `code === OAuthErrorCode.InsufficientScope`. */
export class InsufficientScopeError extends OAuthError {
    constructor(message: string, errorUri?: string) {
        super(OAuthErrorCode.InsufficientScope, message, errorUri);
    }
}

/** @deprecated Use {@linkcode OAuthError} and check `code === OAuthErrorCode.InvalidTarget`. */
export class InvalidTargetError extends OAuthError {
    constructor(message: string, errorUri?: string) {
        super(OAuthErrorCode.InvalidTarget, message, errorUri);
    }
}

/**
 * An OAuth error with a non-standard error code.
 *
 * @deprecated Use {@linkcode OAuthError} directly — the 2.x base class carries arbitrary
 * codes. Provided for compatibility with SDK 1.x.
 */
export class CustomOAuthError extends OAuthError {
    constructor(code: string, message: string, errorUri?: string) {
        super(code, message, errorUri);
    }
}

/**
 * Maps known OAuth error codes to their corresponding error subclasses.
 *
 * @deprecated Use {@linkcode oauthErrorFromCode} to construct errors from codes, or check
 * `error.code` directly.
 */
export const OAUTH_ERRORS: Readonly<Record<string, OAuthErrorSubclass>> = {
    [OAuthErrorCode.InvalidRequest]: OAuthInvalidRequestError,
    [OAuthErrorCode.InvalidClient]: InvalidClientError,
    [OAuthErrorCode.InvalidGrant]: InvalidGrantError,
    [OAuthErrorCode.UnauthorizedClient]: UnauthorizedClientError,
    [OAuthErrorCode.UnsupportedGrantType]: UnsupportedGrantTypeError,
    [OAuthErrorCode.InvalidScope]: InvalidScopeError,
    [OAuthErrorCode.AccessDenied]: AccessDeniedError,
    [OAuthErrorCode.ServerError]: ServerError,
    [OAuthErrorCode.TemporarilyUnavailable]: TemporarilyUnavailableError,
    [OAuthErrorCode.UnsupportedResponseType]: UnsupportedResponseTypeError,
    [OAuthErrorCode.UnsupportedTokenType]: UnsupportedTokenTypeError,
    [OAuthErrorCode.InvalidToken]: InvalidTokenError,
    [OAuthErrorCode.MethodNotAllowed]: MethodNotAllowedError,
    [OAuthErrorCode.TooManyRequests]: TooManyRequestsError,
    [OAuthErrorCode.InvalidClientMetadata]: InvalidClientMetadataError,
    [OAuthErrorCode.InsufficientScope]: InsufficientScopeError,
    [OAuthErrorCode.InvalidTarget]: InvalidTargetError
};

/**
 * Error codes that indicate a transient condition where retrying the request may succeed.
 */
const TRANSIENT_OAUTH_ERROR_CODES: ReadonlySet<string> = new Set([
    OAuthErrorCode.ServerError,
    OAuthErrorCode.TemporarilyUnavailable,
    OAuthErrorCode.TooManyRequests
]);

const KNOWN_OAUTH_ERROR_CODES: ReadonlySet<string> = new Set(Object.values(OAuthErrorCode));

/**
 * Creates an {@linkcode OAuthError} from an error code, returning the specific subclass for
 * known codes so that `instanceof` checks (e.g. `error instanceof InvalidGrantError`) work.
 *
 * Unknown / non-standard codes produce a plain {@linkcode OAuthError} that preserves the
 * raw code.
 */
export function oauthErrorFromCode(code: OAuthErrorCode | string, message: string, errorUri?: string): OAuthError {
    // The code comes from untrusted server responses: guard against prototype-chain
    // lookups (e.g. a server returning "constructor" or "__proto__" as the error code).
    const ErrorClass = Object.hasOwn(OAUTH_ERRORS, code) ? OAUTH_ERRORS[code] : undefined;
    if (ErrorClass) {
        return new ErrorClass(message, errorUri);
    }
    return new OAuthError(code, message, errorUri);
}

/**
 * Returns `true` when an OAuth error indicates a transient condition that may succeed on
 * retry: `server_error`, `temporarily_unavailable`, `too_many_requests` — or any error code
 * not defined in {@linkcode OAuthErrorCode}.
 *
 * Treating unknown codes as transient matches SDK 1.x, which collapsed unrecognized error
 * codes into `ServerError`. Authorization servers in the wild return non-standard codes
 * (e.g. `invalid_refresh_token`) for conditions that are not permanent; treating them as
 * permanent failures would stop retry/refresh loops that previously recovered.
 */
export function isTransientOAuthError(error: unknown): boolean {
    if (!(error instanceof OAuthError)) {
        return false;
    }
    return TRANSIENT_OAUTH_ERROR_CODES.has(error.code) || !KNOWN_OAUTH_ERROR_CODES.has(error.code);
}
