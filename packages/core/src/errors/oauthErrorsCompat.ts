/**
 * v1-compat: OAuth error subclasses.
 *
 * v1 shipped one `Error` subclass per OAuth error code (e.g. `InvalidTokenError`).
 * v2 also exposes the consolidated {@link OAuthError} + {@link OAuthErrorCode} enum.
 * These thin wrappers preserve `throw new InvalidTokenError(msg)` and `instanceof`
 * patterns from v1 and set `.code` to the matching enum value.
 */

import { OAuthError, OAuthErrorCode } from '../auth/errors.js';

type OAuthErrorSubclass = {
    new (message: string, errorUri?: string): OAuthError;
    /** @deprecated Use the instance `.code` property. */
    errorCode: string;
};

function sub(code: OAuthErrorCode, name: string): OAuthErrorSubclass {
    const Sub = class extends OAuthError {
        static errorCode = code;
        constructor(message: string, errorUri?: string) {
            super(code, message, errorUri);
            this.name = name;
        }
    };
    Object.defineProperty(Sub, 'name', { value: name, configurable: true });
    return Sub;
}

/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare */

/** @deprecated Use `OAuthError` with `OAuthErrorCode.InvalidRequest`. */
export const InvalidRequestError = sub(OAuthErrorCode.InvalidRequest, 'InvalidRequestError');
/** @deprecated Use `OAuthError` with `OAuthErrorCode.InvalidRequest`. */
export type InvalidRequestError = InstanceType<typeof InvalidRequestError>;
/** @deprecated Use `OAuthError` with `OAuthErrorCode.InvalidClient`. */
export const InvalidClientError = sub(OAuthErrorCode.InvalidClient, 'InvalidClientError');
/** @deprecated Use `OAuthError` with `OAuthErrorCode.InvalidClient`. */
export type InvalidClientError = InstanceType<typeof InvalidClientError>;
/** @deprecated Use `OAuthError` with `OAuthErrorCode.InvalidGrant`. */
export const InvalidGrantError = sub(OAuthErrorCode.InvalidGrant, 'InvalidGrantError');
/** @deprecated Use `OAuthError` with `OAuthErrorCode.InvalidGrant`. */
export type InvalidGrantError = InstanceType<typeof InvalidGrantError>;
/** @deprecated Use `OAuthError` with `OAuthErrorCode.UnauthorizedClient`. */
export const UnauthorizedClientError = sub(OAuthErrorCode.UnauthorizedClient, 'UnauthorizedClientError');
/** @deprecated Use `OAuthError` with `OAuthErrorCode.UnauthorizedClient`. */
export type UnauthorizedClientError = InstanceType<typeof UnauthorizedClientError>;
/** @deprecated Use `OAuthError` with `OAuthErrorCode.UnsupportedGrantType`. */
export const UnsupportedGrantTypeError = sub(OAuthErrorCode.UnsupportedGrantType, 'UnsupportedGrantTypeError');
/** @deprecated Use `OAuthError` with `OAuthErrorCode.UnsupportedGrantType`. */
export type UnsupportedGrantTypeError = InstanceType<typeof UnsupportedGrantTypeError>;
/** @deprecated Use `OAuthError` with `OAuthErrorCode.InvalidScope`. */
export const InvalidScopeError = sub(OAuthErrorCode.InvalidScope, 'InvalidScopeError');
/** @deprecated Use `OAuthError` with `OAuthErrorCode.InvalidScope`. */
export type InvalidScopeError = InstanceType<typeof InvalidScopeError>;
/** @deprecated Use `OAuthError` with `OAuthErrorCode.AccessDenied`. */
export const AccessDeniedError = sub(OAuthErrorCode.AccessDenied, 'AccessDeniedError');
/** @deprecated Use `OAuthError` with `OAuthErrorCode.AccessDenied`. */
export type AccessDeniedError = InstanceType<typeof AccessDeniedError>;
/** @deprecated Use `OAuthError` with `OAuthErrorCode.ServerError`. */
export const ServerError = sub(OAuthErrorCode.ServerError, 'ServerError');
/** @deprecated Use `OAuthError` with `OAuthErrorCode.ServerError`. */
export type ServerError = InstanceType<typeof ServerError>;
/** @deprecated Use `OAuthError` with `OAuthErrorCode.TemporarilyUnavailable`. */
export const TemporarilyUnavailableError = sub(OAuthErrorCode.TemporarilyUnavailable, 'TemporarilyUnavailableError');
/** @deprecated Use `OAuthError` with `OAuthErrorCode.TemporarilyUnavailable`. */
export type TemporarilyUnavailableError = InstanceType<typeof TemporarilyUnavailableError>;
/** @deprecated Use `OAuthError` with `OAuthErrorCode.UnsupportedResponseType`. */
export const UnsupportedResponseTypeError = sub(OAuthErrorCode.UnsupportedResponseType, 'UnsupportedResponseTypeError');
/** @deprecated Use `OAuthError` with `OAuthErrorCode.UnsupportedResponseType`. */
export type UnsupportedResponseTypeError = InstanceType<typeof UnsupportedResponseTypeError>;
/** @deprecated Use `OAuthError` with `OAuthErrorCode.UnsupportedTokenType`. */
export const UnsupportedTokenTypeError = sub(OAuthErrorCode.UnsupportedTokenType, 'UnsupportedTokenTypeError');
/** @deprecated Use `OAuthError` with `OAuthErrorCode.UnsupportedTokenType`. */
export type UnsupportedTokenTypeError = InstanceType<typeof UnsupportedTokenTypeError>;
/** @deprecated Use `OAuthError` with `OAuthErrorCode.InvalidToken`. */
export const InvalidTokenError = sub(OAuthErrorCode.InvalidToken, 'InvalidTokenError');
/** @deprecated Use `OAuthError` with `OAuthErrorCode.InvalidToken`. */
export type InvalidTokenError = InstanceType<typeof InvalidTokenError>;
/** @deprecated Use `OAuthError` with `OAuthErrorCode.MethodNotAllowed`. */
export const MethodNotAllowedError = sub(OAuthErrorCode.MethodNotAllowed, 'MethodNotAllowedError');
/** @deprecated Use `OAuthError` with `OAuthErrorCode.MethodNotAllowed`. */
export type MethodNotAllowedError = InstanceType<typeof MethodNotAllowedError>;
/** @deprecated Use `OAuthError` with `OAuthErrorCode.TooManyRequests`. */
export const TooManyRequestsError = sub(OAuthErrorCode.TooManyRequests, 'TooManyRequestsError');
/** @deprecated Use `OAuthError` with `OAuthErrorCode.TooManyRequests`. */
export type TooManyRequestsError = InstanceType<typeof TooManyRequestsError>;
/** @deprecated Use `OAuthError` with `OAuthErrorCode.InvalidClientMetadata`. */
export const InvalidClientMetadataError = sub(OAuthErrorCode.InvalidClientMetadata, 'InvalidClientMetadataError');
/** @deprecated Use `OAuthError` with `OAuthErrorCode.InvalidClientMetadata`. */
export type InvalidClientMetadataError = InstanceType<typeof InvalidClientMetadataError>;
/** @deprecated Use `OAuthError` with `OAuthErrorCode.InsufficientScope`. */
export const InsufficientScopeError = sub(OAuthErrorCode.InsufficientScope, 'InsufficientScopeError');
/** @deprecated Use `OAuthError` with `OAuthErrorCode.InsufficientScope`. */
export type InsufficientScopeError = InstanceType<typeof InsufficientScopeError>;
/** @deprecated Use `OAuthError` with `OAuthErrorCode.InvalidTarget`. */
export const InvalidTargetError = sub(OAuthErrorCode.InvalidTarget, 'InvalidTargetError');
/** @deprecated Use `OAuthError` with `OAuthErrorCode.InvalidTarget`. */
export type InvalidTargetError = InstanceType<typeof InvalidTargetError>;

/**
 * @deprecated Construct {@link OAuthError} directly with a custom code string.
 *
 * v1 pattern was `class MyErr extends CustomOAuthError { static errorCode = 'my_code' }`;
 * this preserves that by reading `static errorCode` from the concrete subclass.
 */
export class CustomOAuthError extends OAuthError {
    static errorCode: string;
    constructor(message: string, errorUri?: string) {
        super((new.target as typeof CustomOAuthError).errorCode, message, errorUri);
    }
}
