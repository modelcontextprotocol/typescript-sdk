import type { AuthInfo } from '@modelcontextprotocol/core';
import { InsufficientScopeError, InvalidTokenError, OAuthError, ServerError } from '@modelcontextprotocol/core';

import type { OAuthTokenVerifier } from '../provider.js';
import { jsonResponse } from '../web.js';

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
};

/**
 * Validates a Bearer token in the Authorization header.
 *
 * Returns either `{ authInfo }` on success or `{ response }` on failure.
 */
export async function requireBearerAuth(
    req: Request,
    { verifier, requiredScopes = [], resourceMetadataUrl }: BearerAuthMiddlewareOptions
): Promise<{ authInfo: AuthInfo } | { response: Response }> {
    try {
        const authHeader = req.headers.get('authorization');
        if (!authHeader) {
            throw new InvalidTokenError('Missing Authorization header');
        }

        const [type, token] = authHeader.split(' ');
        if (type!.toLowerCase() !== 'bearer' || !token) {
            throw new InvalidTokenError("Invalid Authorization header format, expected 'Bearer TOKEN'");
        }

        const authInfo = await verifier.verifyAccessToken(token);

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

        return { authInfo };
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
            return {
                response: jsonResponse(error.toResponseObject(), {
                    status: 401,
                    headers: { 'WWW-Authenticate': buildWwwAuthHeader(error.errorCode, error.message) }
                })
            };
        }
        if (error instanceof InsufficientScopeError) {
            return {
                response: jsonResponse(error.toResponseObject(), {
                    status: 403,
                    headers: { 'WWW-Authenticate': buildWwwAuthHeader(error.errorCode, error.message) }
                })
            };
        }
        if (error instanceof ServerError) {
            return { response: jsonResponse(error.toResponseObject(), { status: 500 }) };
        }
        if (error instanceof OAuthError) {
            return { response: jsonResponse(error.toResponseObject(), { status: 400 }) };
        }
        const serverError = new ServerError('Internal Server Error');
        return { response: jsonResponse(serverError.toResponseObject(), { status: 500 }) };
    }
}
