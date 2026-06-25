import { Response } from 'express';
import { OAuthRegisteredClientsStore } from './clients.js';
import { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '../../shared/auth.js';
import { AuthInfo } from './types.js';

export type AuthorizationParams = {
    state?: string;
    scopes?: string[];
    codeChallenge: string;
    redirectUri: string;
    resource?: URL;
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
     */
    authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void>;

    /**
     * Returns the `codeChallenge` that was used when the indicated authorization began.
     */
    challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string>;

    /**
     * Returns the `redirect_uri` that was used when the indicated authorization began, if available.
     *
     * When implemented, the token handler validates that the token request uses the same
     * redirect URI, as required by RFC 6749 section 4.1.3.
     */
    redirectUriForAuthorizationCode?(client: OAuthClientInformationFull, authorizationCode: string): Promise<string | undefined>;

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
     * Revokes all tokens previously issued for the indicated authorization code.
     *
     * OAuth 2.1 section 4.1.3 recommends revoking previously issued tokens when
     * authorization code reuse is detected. Providers that track code-to-token
     * relationships can implement this hook to let the token handler trigger that cleanup.
     */
    revokeTokensForAuthorizationCode?(client: OAuthClientInformationFull, authorizationCode: string): Promise<void>;

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
