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
     * Creates an OAuthError from an OAuth error response.
     */
    static fromResponse(response: OAuthErrorResponse): OAuthError {
        return new OAuthError(response.error as OAuthErrorCode, response.error_description ?? response.error, response.error_uri);
    }
}
