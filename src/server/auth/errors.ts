import { OAuthErrorResponse } from "../../shared/auth.js";

/**
 * Base class for all OAuth errors
 */
export class OAuthError extends Error {
  constructor(
    public readonly errorCode: string,
    message: string,
    public readonly errorUri?: string
  ) {
    super(message);
    this.name = this.constructor.name;
  }

  /**
   * Converts the error to a standard OAuth error response object
   */
  toResponseObject(): OAuthErrorResponse {
    const response: OAuthErrorResponse = {
      error: this.errorCode,
      error_description: this.message
    };

    if (this.errorUri) {
      response.error_uri = this.errorUri;
    }

    return response;
  }
}

/**
 * Invalid request error - The request is missing a required parameter,
 * includes an invalid parameter value, includes a parameter more than once,
 * or is otherwise malformed.
 */
export class InvalidRequestError extends OAuthError {
  constructor(message: string, errorUri?: string) {
    super("invalid_request", message, errorUri);
  }
}

/**
 * Invalid client error - Client authentication failed (e.g., unknown client, no client
 * authentication included, or unsupported authentication method).
 */
export class InvalidClientError extends OAuthError {
  constructor(message: string, errorUri?: string) {
    super("invalid_client", message, errorUri);
  }
}

/**
 * Invalid grant error - The provided authorization grant or refresh token is
 * invalid, expired, revoked, does not match the redirection URI used in the
 * authorization request, or was issued to another client.
 */
export class InvalidGrantError extends OAuthError {
  constructor(message: string, errorUri?: string) {
    super("invalid_grant", message, errorUri);
  }
}

/**
 * Unauthorized client error - The authenticated client is not authorized to use
 * this authorization grant type.
 */
export class UnauthorizedClientError extends OAuthError {
  constructor(message: string, errorUri?: string) {
    super("unauthorized_client", message, errorUri);
  }
}

/**
 * Unsupported grant type error - The authorization grant type is not supported
 * by the authorization server.
 */
export class UnsupportedGrantTypeError extends OAuthError {
  constructor(message: string, errorUri?: string) {
    super("unsupported_grant_type", message, errorUri);
  }
}

/**
 * Invalid scope error - The requested scope is invalid, unknown, malformed, or
 * exceeds the scope granted by the resource owner.
 */
export class InvalidScopeError extends OAuthError {
  constructor(message: string, errorUri?: string) {
    super("invalid_scope", message, errorUri);
  }
}

/**
 * Access denied error - The resource owner or authorization server denied the request.
 */
export class AccessDeniedError extends OAuthError {
  constructor(message: string, errorUri?: string) {
    super("access_denied", message, errorUri);
  }
}

/**
 * Server error - The authorization server encountered an unexpected condition
 * that prevented it from fulfilling the request.
 */
export class ServerError extends OAuthError {
  constructor(message: string, errorUri?: string) {
    super("server_error", message, errorUri);
  }
}

/**
 * Temporarily unavailable error - The authorization server is currently unable to
 * handle the request due to a temporary overloading or maintenance of the server.
 */
export class TemporarilyUnavailableError extends OAuthError {
  constructor(message: string, errorUri?: string) {
    super("temporarily_unavailable", message, errorUri);
  }
}

/**
 * Unsupported response type error - The authorization server does not support
 * obtaining an authorization code using this method.
 */
export class UnsupportedResponseTypeError extends OAuthError {
  constructor(message: string, errorUri?: string) {
    super("unsupported_response_type", message, errorUri);
  }
}

/**
 * Unsupported token type error - The authorization server does not support
 * the requested token type.
 */
export class UnsupportedTokenTypeError extends OAuthError {
  constructor(message: string, errorUri?: string) {
    super("unsupported_token_type", message, errorUri);
  }
}

/**
 * Invalid token error - The access token provided is expired, revoked, malformed,
 * or invalid for other reasons.
 */
export class InvalidTokenError extends OAuthError {
  constructor(message: string, errorUri?: string) {
    super("invalid_token", message, errorUri);
  }
}

/**
 * Method not allowed error - The HTTP method used is not allowed for this endpoint.
 * (Custom, non-standard error)
 */
export class MethodNotAllowedError extends OAuthError {
  constructor(message: string, errorUri?: string) {
    super("method_not_allowed", message, errorUri);
  }
}

/**
 * Too many requests error - Rate limit exceeded.
 * (Custom, non-standard error based on RFC 6585)
 */
export class TooManyRequestsError extends OAuthError {
  constructor(message: string, errorUri?: string) {
    super("too_many_requests", message, errorUri);
  }
}

/**
 * Invalid client metadata error - The client metadata is invalid.
 * (Custom error for dynamic client registration - RFC 7591)
 */
export class InvalidClientMetadataError extends OAuthError {
  constructor(message: string, errorUri?: string) {
    super("invalid_client_metadata", message, errorUri);
  }
}

/**
 * Insufficient scope error - The request requires higher privileges than provided by the access token.
 */
export class InsufficientScopeError extends OAuthError {
  constructor(message: string, errorUri?: string) {
    super("insufficient_scope", message, errorUri);
  }
}
