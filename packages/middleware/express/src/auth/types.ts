import type { AuthInfo } from '@modelcontextprotocol/server';

/**
 * Minimal token-verifier interface for MCP servers acting as an OAuth 2.0
 * Resource Server. Implementations introspect or locally validate an access
 * token and return the resulting {@link AuthInfo}, which is then attached to
 * the Express request and surfaced to MCP request handlers via
 * `ctx.http.authInfo`.
 *
 * This is intentionally narrower than a full OAuth Authorization Server
 * provider — it only covers the verification step a Resource Server needs.
 */
export interface OAuthTokenVerifier {
    /**
     * Verifies an access token and returns information about it.
     *
     * Implementations should throw an `OAuthError` (from `@modelcontextprotocol/server`)
     * with `OAuthErrorCode.InvalidToken` when
     * the token is unknown, revoked, or otherwise invalid; `requireBearerAuth`
     * maps that to a 401 with a `WWW-Authenticate` challenge.
     *
     * Note: `requireBearerAuth` rejects tokens whose `AuthInfo.expiresAt` is unset
     * (matches v1 behavior). Ensure your verifier populates it (e.g. from RFC 7662
     * introspection `exp` or the JWT `exp` claim).
     */
    verifyAccessToken(token: string): Promise<AuthInfo>;
}

declare module 'express-serve-static-core' {
    interface Request {
        /**
         * Information about the validated access token, populated by
         * `requireBearerAuth`.
         */
        auth?: AuthInfo;
    }
}
