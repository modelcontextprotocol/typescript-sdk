/**
 * Auth Middleware for MCP Demo Servers
 *
 * 🚨 DEMO ONLY - NOT FOR PRODUCTION
 *
 * This provides bearer auth middleware for MCP servers.
 */

import type { NextFunction, Request, Response } from 'express';

import { verifyAccessToken } from './authServer.js';

export interface RequireBearerAuthOptions {
    requiredScopes?: string[];
    resourceMetadataUrl?: URL;
    strictResource?: boolean;
    expectedResource?: URL;
}

/**
 * Express middleware that requires a valid Bearer token.
 * Sets `req.app.locals.auth` on success.
 */
export function requireBearerAuth(
    options: RequireBearerAuthOptions = {}
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
    const { requiredScopes = [], resourceMetadataUrl, strictResource = false, expectedResource } = options;

    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            const wwwAuthenticate = resourceMetadataUrl ? `Bearer resource_metadata="${resourceMetadataUrl.toString()}"` : 'Bearer';

            res.set('WWW-Authenticate', wwwAuthenticate);
            res.status(401).json({
                error: 'unauthorized',
                error_description: 'Missing or invalid Authorization header'
            });
            return;
        }

        const token = authHeader.slice(7); // Remove 'Bearer ' prefix

        try {
            const authInfo = await verifyAccessToken(token, {
                strictResource,
                expectedResource
            });

            // Check required scopes
            if (requiredScopes.length > 0) {
                const hasAllScopes = requiredScopes.every(scope => authInfo.scopes.includes(scope));
                if (!hasAllScopes) {
                    res.status(403).json({
                        error: 'insufficient_scope',
                        error_description: `Required scopes: ${requiredScopes.join(', ')}`
                    });
                    return;
                }
            }

            req.app.locals.auth = authInfo;
            next();
        } catch (error) {
            const wwwAuthenticate = resourceMetadataUrl
                ? `Bearer error="invalid_token", resource_metadata="${resourceMetadataUrl.toString()}"`
                : 'Bearer error="invalid_token"';

            res.set('WWW-Authenticate', wwwAuthenticate);
            res.status(401).json({
                error: 'invalid_token',
                error_description: error instanceof Error ? error.message : 'Invalid token'
            });
        }
    };
}

/**
 * Helper to get the protected resource metadata URL from a server URL.
 */
export function getOAuthProtectedResourceMetadataUrl(serverUrl: URL): URL {
    const metadataUrl = new URL(serverUrl);
    // Insert well-known between host and path per RFC 9728 Section 3
    metadataUrl.pathname = `/.well-known/oauth-protected-resource${serverUrl.pathname}`;
    return metadataUrl;
}
