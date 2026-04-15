// v1 compat: `@modelcontextprotocol/sdk/server/auth/errors.js`
// v2 consolidated 17 OAuth error subclasses into OAuthError + OAuthErrorCode.
// These deprecated subclasses preserve `instanceof` and `throw new InvalidTokenError(msg)` patterns.

import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';

/** @deprecated Construct-signature type for the v1 OAuth error subclasses below. */
export type OAuthErrorSubclass = new (message: string, errorUri?: string) => OAuthError;

function sub(code: OAuthErrorCode): OAuthErrorSubclass {
    return class extends OAuthError {
        constructor(message: string, errorUri?: string) {
            super(code, message, errorUri);
        }
    };
}

/** @deprecated Use `new OAuthError(OAuthErrorCode.InvalidRequest, ...)` */
export const InvalidRequestError = sub(OAuthErrorCode.InvalidRequest);
/** @deprecated Use `new OAuthError(OAuthErrorCode.InvalidClient, ...)` */
export const InvalidClientError = sub(OAuthErrorCode.InvalidClient);
/** @deprecated Use `new OAuthError(OAuthErrorCode.InvalidGrant, ...)` */
export const InvalidGrantError = sub(OAuthErrorCode.InvalidGrant);
/** @deprecated Use `new OAuthError(OAuthErrorCode.UnauthorizedClient, ...)` */
export const UnauthorizedClientError = sub(OAuthErrorCode.UnauthorizedClient);
/** @deprecated Use `new OAuthError(OAuthErrorCode.UnsupportedGrantType, ...)` */
export const UnsupportedGrantTypeError = sub(OAuthErrorCode.UnsupportedGrantType);
/** @deprecated Use `new OAuthError(OAuthErrorCode.InvalidScope, ...)` */
export const InvalidScopeError = sub(OAuthErrorCode.InvalidScope);
/** @deprecated Use `new OAuthError(OAuthErrorCode.AccessDenied, ...)` */
export const AccessDeniedError = sub(OAuthErrorCode.AccessDenied);
/** @deprecated Use `new OAuthError(OAuthErrorCode.ServerError, ...)` */
export const ServerError = sub(OAuthErrorCode.ServerError);
/** @deprecated Use `new OAuthError(OAuthErrorCode.TemporarilyUnavailable, ...)` */
export const TemporarilyUnavailableError = sub(OAuthErrorCode.TemporarilyUnavailable);
/** @deprecated Use `new OAuthError(OAuthErrorCode.UnsupportedResponseType, ...)` */
export const UnsupportedResponseTypeError = sub(OAuthErrorCode.UnsupportedResponseType);
/** @deprecated Use `new OAuthError(OAuthErrorCode.UnsupportedTokenType, ...)` */
export const UnsupportedTokenTypeError = sub(OAuthErrorCode.UnsupportedTokenType);
/** @deprecated Use `new OAuthError(OAuthErrorCode.InvalidToken, ...)` */
export const InvalidTokenError = sub(OAuthErrorCode.InvalidToken);
/** @deprecated Use `new OAuthError(OAuthErrorCode.MethodNotAllowed, ...)` */
export const MethodNotAllowedError = sub(OAuthErrorCode.MethodNotAllowed);
/** @deprecated Use `new OAuthError(OAuthErrorCode.TooManyRequests, ...)` */
export const TooManyRequestsError = sub(OAuthErrorCode.TooManyRequests);
/** @deprecated Use `new OAuthError(OAuthErrorCode.InvalidClientMetadata, ...)` */
export const InvalidClientMetadataError = sub(OAuthErrorCode.InvalidClientMetadata);
/** @deprecated Use `new OAuthError(OAuthErrorCode.InsufficientScope, ...)` */
export const InsufficientScopeError = sub(OAuthErrorCode.InsufficientScope);

/** @deprecated Construct {@link OAuthError} directly. */
export class CustomOAuthError extends OAuthError {}

export { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
