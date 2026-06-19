import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/core';
import type { Response } from 'express';

import type { OAuthRegisteredClientsStore } from './clients.js';
import type { AuthInfo } from './types.js';

export type AuthorizationParams = {
    state?: string;
    scopes?: string[];
    codeChallenge: string;
    redirectUri: string;
    resource?: URL;
    /**
     * The authorization server's own issuer identifier (the `issuerUrl` configured on
     * `mcpAuthRouter`). Informational: the bundled `authorizationHandler` already appends
     * this as the `iss` query parameter (RFC 9207 §2) to any `res.redirect(...)` your
     * `authorize()` issues to {@linkcode AuthorizationParams.redirectUri | redirectUri}. You
     * only need to append it yourself when the final callback redirect is issued from a
     * different response (e.g. after a separate consent-page POST).
     */
    issuer?: string;
};

/**
 * Implements an end-to-end OAuth server.
 */
export interface OAuthServerProvider {
    /**
     * A store used to read information about registered OAuth clients.
     */
    get clientsStore(): OAuthRegisteredClientsStore;

    /**
     * Begins the authorization flow, which can either be implemented by this server itself or via redirection to a separate authorization server.
     *
     * This server must eventually issue a redirect with an authorization response or an error response to the given redirect URI. Per OAuth 2.1:
     * - In the successful case, the redirect MUST include the `code` and `state` (if present) query parameters.
     * - In the error case, the redirect MUST include the `error` query parameter, and MAY include an optional `error_description` query parameter.
     *
     * RFC 9207: the bundled `authorizationHandler` appends `iss` **only** to `res.redirect(...)` calls you issue
     * on the supplied `res` to `params.redirectUri`, so an implementation that redirects that way requires no
     * change. If you emit the `Location` header another way (e.g. `res.writeHead(302, { Location: ... })`), or
     * issue the final callback redirect from a different response (e.g. after a separate consent step), append
     * {@linkcode AuthorizationParams.issuer | params.issuer} as `iss` yourself, or set
     * {@linkcode OAuthServerProvider.authorizationResponseIssParameterSupported} to `false` so the metadata does
     * not over-claim.
     */
    authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void>;

    /**
     * Returns the `codeChallenge` that was used when the indicated authorization began.
     */
    challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string>;

    /**
     * Exchanges an authorization code for an access token.
     */
    exchangeAuthorizationCode(
        client: OAuthClientInformationFull,
        authorizationCode: string,
        codeVerifier?: string,
        redirectUri?: string,
        resource?: URL
    ): Promise<OAuthTokens>;

    /**
     * Exchanges a refresh token for an access token.
     */
    exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens>;

    /**
     * Verifies an access token and returns information about it.
     */
    verifyAccessToken(token: string): Promise<AuthInfo>;

    /**
     * Revokes an access or refresh token. If unimplemented, token revocation is not supported (not recommended).
     *
     * If the given token is invalid or already revoked, this method should do nothing.
     */
    revokeToken?(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void>;

    /**
     * Whether this provider's authorization responses carry the RFC 9207 `iss` parameter.
     * Drives the `authorization_response_iss_parameter_supported` metadata field. Defaults to
     * `true` — the bundled `authorizationHandler` appends `iss` to redirects it issues to the
     * client's `redirect_uri`. Set to `false` when the callback is issued by an upstream
     * authorization server this provider delegates to (e.g. `ProxyOAuthServerProvider`), so the
     * published metadata does not over-claim support.
     */
    authorizationResponseIssParameterSupported?: boolean;

    /**
     * Whether to skip local PKCE validation.
     *
     * If true, the server will not perform PKCE validation locally and will pass the code_verifier to the upstream server.
     *
     * NOTE: This should only be true if the upstream server is performing the actual PKCE validation.
     */
    skipLocalPkceValidation?: boolean;
}

/**
 * Slim implementation useful for token verification
 */
export interface OAuthTokenVerifier {
    /**
     * Verifies an access token and returns information about it.
     */
    verifyAccessToken(token: string): Promise<AuthInfo>;
}
