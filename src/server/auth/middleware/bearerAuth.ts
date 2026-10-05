import { RequestHandler } from 'express';
import { InsufficientScopeError, InvalidTokenError, OAuthError, ServerError } from '../errors.js';
import { OAuthTokenVerifier } from '../provider.js';
import { AuthInfo } from '../types.js';

export type BearerAuthMiddlewareOptions = {
    /**
     * A provider used to verify tokens.
     */
    verifier: OAuthTokenVerifier;

    /**
     * Optional scopes that the token must have.
     */
    requiredScopes?: string[];

    /**
     * Optional resource metadata URL to include in WWW-Authenticate header.
     */
    resourceMetadataUrl?: string;

    /**
     * Accept only tokens issued for this resource (the token's audience): the value the authorization server puts
     * into tokens meant for this server, usually the server's URL.
     * When set, a token is accepted only if the verifier reports that value in `AuthInfo.resource`
     * (compared as strings, ignoring a fragment and one trailing slash); any other token is refused with `401 invalid_token`.
     * When unset, `AuthInfo.resource` is not compared with anything.
     */
    expectedResource?: URL;
};

// The serialized value without its fragment and without one trailing slash.
function comparableResource(value: URL): string {
    const text = String(value);
    const hash = text.indexOf('#');
    return (hash === -1 ? text : text.slice(0, hash)).replace(/\/$/, '');
}

// A reported resource matches when it serializes to the same string as the expected one, fragment and one trailing slash aside.
function sameResource(reported: URL | undefined, expected: URL): boolean {
    if (!reported) return false;
    return comparableResource(reported) === comparableResource(expected);
}

declare module 'express-serve-static-core' {
    interface Request {
        /**
         * Information about the validated access token, if the `requireBearerAuth` middleware was used.
         */
        auth?: AuthInfo;
    }
}

/**
 * Middleware that requires a valid Bearer token in the Authorization header.
 *
 * This will validate the token with the auth provider and add the resulting auth info to the request object.
 *
 * If resourceMetadataUrl is provided, it will be included in the WWW-Authenticate header
 * for 401 responses as per the OAuth 2.0 Protected Resource Metadata spec.
 */
export function requireBearerAuth({
    verifier,
    requiredScopes = [],
    resourceMetadataUrl,
    expectedResource
}: BearerAuthMiddlewareOptions): RequestHandler {
    return async (req, res, next) => {
        try {
            const authHeader = req.headers.authorization;
            if (!authHeader) {
                throw new InvalidTokenError('Missing Authorization header');
            }

            const [type, token] = authHeader.split(' ');
            if (type.toLowerCase() !== 'bearer' || !token) {
                throw new InvalidTokenError("Invalid Authorization header format, expected 'Bearer TOKEN'");
            }

            const authInfo = await verifier.verifyAccessToken(token);

            // Check if the token was issued for this server (if configured)
            if (expectedResource !== undefined && !sameResource(authInfo.resource, expectedResource)) {
                throw new InvalidTokenError('Token was not issued for this resource');
            }

            // Check if token has the required scopes (if any)
            if (requiredScopes.length > 0) {
                const hasAllScopes = requiredScopes.every(scope => authInfo.scopes.includes(scope));

                if (!hasAllScopes) {
                    throw new InsufficientScopeError('Insufficient scope');
                }
            }

            // Check if the token is set to expire or if it is expired
            if (typeof authInfo.expiresAt !== 'number' || isNaN(authInfo.expiresAt)) {
                throw new InvalidTokenError('Token has no expiration time');
            } else if (authInfo.expiresAt < Date.now() / 1000) {
                throw new InvalidTokenError('Token has expired');
            }

            req.auth = authInfo;
            next();
        } catch (error) {
            // Build WWW-Authenticate header parts
            const buildWwwAuthHeader = (errorCode: string, message: string): string => {
                let header = `Bearer error="${errorCode}", error_description="${message}"`;
                if (requiredScopes.length > 0) {
                    header += `, scope="${requiredScopes.join(' ')}"`;
                }
                if (resourceMetadataUrl) {
                    header += `, resource_metadata="${resourceMetadataUrl}"`;
                }
                return header;
            };

            if (error instanceof InvalidTokenError) {
                res.set('WWW-Authenticate', buildWwwAuthHeader(error.errorCode, error.message));
                res.status(401).json(error.toResponseObject());
            } else if (error instanceof InsufficientScopeError) {
                res.set('WWW-Authenticate', buildWwwAuthHeader(error.errorCode, error.message));
                res.status(403).json(error.toResponseObject());
            } else if (error instanceof ServerError) {
                res.status(500).json(error.toResponseObject());
            } else if (error instanceof OAuthError) {
                res.status(400).json(error.toResponseObject());
            } else {
                const serverError = new ServerError('Internal Server Error');
                res.status(500).json(serverError.toResponseObject());
            }
        }
    };
}
