/**
 * Auth Middleware for MCP Demo Servers
 *
 * 🚨 DEMO ONLY - NOT FOR PRODUCTION
 *
 * This provides bearer auth middleware and metadata routes for MCP servers.
 */

import type { OAuthMetadata, OAuthProtectedResourceMetadata } from '@modelcontextprotocol/server';
import type { NextFunction, Request, Response, Router } from 'express';
import express from 'express';

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

export interface McpAuthMetadataRouterOptions {
    oauthMetadata: OAuthMetadata;
    resourceServerUrl: URL;
    scopesSupported?: string[];
    resourceName?: string;
}

/**
 * Creates an Express router that serves OAuth and Protected Resource metadata.
 */
export function mcpAuthMetadataRouter(options: McpAuthMetadataRouterOptions): Router {
    const { oauthMetadata, resourceServerUrl, scopesSupported = ['mcp:tools'], resourceName } = options;

    const router = express.Router();

    // OAuth Protected Resource Metadata (RFC 9728)
    const protectedResourceMetadata: OAuthProtectedResourceMetadata = {
        resource: resourceServerUrl.toString(),
        authorization_servers: [oauthMetadata.issuer],
        scopes_supported: scopesSupported,
        resource_name: resourceName
    };

    // Serve protected resource metadata
    router.get('/.well-known/oauth-protected-resource', (req: Request, res: Response) => {
        res.json(protectedResourceMetadata);
    });

    // Also serve at the MCP-specific path
    const mcpPath = new URL(resourceServerUrl.pathname, resourceServerUrl).pathname;
    router.get(`${mcpPath}/.well-known/oauth-protected-resource`, (req: Request, res: Response) => {
        res.json(protectedResourceMetadata);
    });

    return router;
}

/**
 * Helper to get the protected resource metadata URL from a server URL.
 */
export function getOAuthProtectedResourceMetadataUrl(serverUrl: URL): URL {
    const metadataUrl = new URL(serverUrl);
    metadataUrl.pathname = `${serverUrl.pathname}/.well-known/oauth-protected-resource`.replace(/\/+/g, '/');
    return metadataUrl;
}
