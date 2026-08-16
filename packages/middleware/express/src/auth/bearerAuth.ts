import type { BearerAuthOptions } from '@modelcontextprotocol/server';
import { bearerAuthChallengeResponse, OAuthError, OAuthErrorCode, verifyBearerToken } from '@modelcontextprotocol/server';
import type { RequestHandler } from 'express';

/**
 * Options for {@link requireBearerAuth}.
 */
export type BearerAuthMiddlewareOptions = BearerAuthOptions;

/**
 * Express middleware that requires a valid Bearer token in the `Authorization`
 * header.
 *
 * The Express adapter over the runtime-neutral core in
 * `@modelcontextprotocol/server` (`verifyBearerToken` /
 * `bearerAuthChallengeResponse` — or `requireBearerAuth` from that package for
 * web-standard `fetch(request)` hosts). The token is validated via the
 * supplied `OAuthTokenVerifier` and the resulting `AuthInfo` is attached to
 * `req.auth`. The MCP Streamable HTTP transport reads `req.auth` and surfaces
 * it to handlers as `ctx.http.authInfo`.
 *
 * On failure the middleware sends a JSON OAuth error body and a
 * `WWW-Authenticate: Bearer …` challenge that includes the configured
 * `resource_metadata` URL so clients can discover the Authorization Server.
 */
export function requireBearerAuth(options: BearerAuthMiddlewareOptions): RequestHandler {
    // Destructure at creation so a plain-JS caller passing undefined or
    // malformed options crashes at startup, not on the first request.
    const { verifier, requiredScopes = [], resourceMetadataUrl } = options;
    const resolved = { verifier, requiredScopes, resourceMetadataUrl };
    return async (req, res, next) => {
        try {
            req.auth = await verifyBearerToken(req.headers.authorization, resolved);
            next();
        } catch (error) {
            // The core Response supplies status and challenge; the body is
            // derived directly rather than parsed back out of the Response.
            const response = bearerAuthChallengeResponse(error, resolved);
            const challenge = response.headers.get('WWW-Authenticate');
            if (challenge !== null) {
                res.set('WWW-Authenticate', challenge);
            }
            const body = error instanceof OAuthError ? error : new OAuthError(OAuthErrorCode.ServerError, 'Internal Server Error');
            res.status(response.status).json(body.toResponseObject());
        }
    };
}
