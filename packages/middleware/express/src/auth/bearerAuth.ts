import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import type { RequestHandler } from 'express';

import type { OAuthTokenVerifier } from './types.js';

/**
 * Options for {@link requireBearerAuth}.
 */
export interface BearerAuthMiddlewareOptions {
    /**
     * A verifier used to validate access tokens.
     */
    verifier: OAuthTokenVerifier;

    /**
     * Optional scopes that the token must have. When any are missing the
     * middleware responds with `403 insufficient_scope`.
     */
    requiredScopes?: string[];

    /**
     * Optional Protected Resource Metadata URL to advertise in the
     * `WWW-Authenticate` header on 401/403 responses, per
     * {@link https://datatracker.ietf.org/doc/html/rfc9728 | RFC 9728}.
     *
     * Typically built with `getOAuthProtectedResourceMetadataUrl`.
     */
    resourceMetadataUrl?: string;
}

function buildWwwAuthenticateHeader(
    errorCode: string,
    description: string,
    requiredScopes: string[],
    resourceMetadataUrl: string | undefined
): string {
    let header = `Bearer error="${errorCode}", error_description="${description}"`;
    if (requiredScopes.length > 0) {
        header += `, scope="${requiredScopes.join(' ')}"`;
    }
    if (resourceMetadataUrl) {
        header += `, resource_metadata="${resourceMetadataUrl}"`;
    }
    return header;
}

/**
 * Express middleware that requires a valid Bearer token in the `Authorization`
 * header.
 *
 * The token is validated via the supplied {@link OAuthTokenVerifier} and the
 * resulting `AuthInfo` (from `@modelcontextprotocol/server`) is attached
 * to `req.auth`. The MCP Streamable HTTP transport reads `req.auth` and
 * surfaces it to handlers as `ctx.http.authInfo`.
 *
 * On failure the middleware sends a JSON OAuth error body and a
 * `WWW-Authenticate: Bearer …` challenge that includes the configured
 * `resource_metadata` URL so clients can discover the Authorization Server.
 */
export function requireBearerAuth({ verifier, requiredScopes = [], resourceMetadataUrl }: BearerAuthMiddlewareOptions): RequestHandler {
    return async (req, res, next) => {
        try {
            const authHeader = req.headers.authorization;
            if (!authHeader) {
                throw new OAuthError(OAuthErrorCode.InvalidToken, 'Missing Authorization header');
            }

            const [type, token] = authHeader.split(' ');
            if (type?.toLowerCase() !== 'bearer' || !token) {
                throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid Authorization header format, expected 'Bearer TOKEN'");
            }

            const authInfo = await verifier.verifyAccessToken(token);

            // Check if token has the required scopes (if any)
            if (requiredScopes.length > 0) {
                const hasAllScopes = requiredScopes.every(scope => authInfo.scopes.includes(scope));
                if (!hasAllScopes) {
                    throw new OAuthError(OAuthErrorCode.InsufficientScope, 'Insufficient scope');
                }
            }

            // Check if the token is set to expire or if it is expired
            if (typeof authInfo.expiresAt !== 'number' || Number.isNaN(authInfo.expiresAt)) {
                throw new OAuthError(OAuthErrorCode.InvalidToken, 'Token has no expiration time');
            } else if (authInfo.expiresAt < Date.now() / 1000) {
                throw new OAuthError(OAuthErrorCode.InvalidToken, 'Token has expired');
            }

            req.auth = authInfo;
            next();
        } catch (error) {
            if (error instanceof OAuthError) {
                const challenge = buildWwwAuthenticateHeader(error.code, error.message, requiredScopes, resourceMetadataUrl);
                switch (error.code) {
                    case OAuthErrorCode.InvalidToken: {
                        res.set('WWW-Authenticate', challenge);
                        res.status(401).json(error.toResponseObject());
                        break;
                    }
                    case OAuthErrorCode.InsufficientScope: {
                        res.set('WWW-Authenticate', challenge);
                        res.status(403).json(error.toResponseObject());
                        break;
                    }
                    case OAuthErrorCode.ServerError: {
                        res.status(500).json(error.toResponseObject());
                        break;
                    }
                    default: {
                        res.status(400).json(error.toResponseObject());
                    }
                }
            } else {
                const serverError = new OAuthError(OAuthErrorCode.ServerError, 'Internal Server Error');
                res.status(500).json(serverError.toResponseObject());
            }
        }
    };
}
