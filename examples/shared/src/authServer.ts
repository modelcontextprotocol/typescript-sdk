/**
 * Better Auth Server Setup for MCP Demo
 *
 * DEMO ONLY - NOT FOR PRODUCTION
 *
 * This creates a standalone OAuth Authorization Server using better-auth
 * that MCP clients can use to obtain access tokens.
 *
 * See: https://www.better-auth.com/docs/plugins/mcp
 */

import type { OAuthMetadata } from '@modelcontextprotocol/core';
import { toNodeHandler } from 'better-auth/node';
import { oAuthDiscoveryMetadata, oAuthProtectedResourceMetadata } from 'better-auth/plugins';
import type { Request, Response as ExpressResponse, Router } from 'express';
import express from 'express';

import type { DemoAuth } from './auth.js';
import { createDemoAuth } from './auth.js';

export interface SetupAuthServerOptions {
    authServerUrl: URL;
    mcpServerUrl: URL;
    strictResource?: boolean;
}

export interface AuthServerResult {
    auth: DemoAuth;
    oauthMetadata: OAuthMetadata;
}

// Store auth instance globally so it can be used for token verification
let globalAuth: DemoAuth | null = null;

/**
 * Gets the global auth instance (must call setupAuthServer first)
 */
export function getAuth(): DemoAuth {
    if (!globalAuth) {
        throw new Error('Auth not initialized. Call setupAuthServer first.');
    }
    return globalAuth;
}

/**
 * Sets up and starts the OAuth Authorization Server on a separate port.
 *
 * @param options - Server configuration
 * @returns OAuth metadata for the authorization server
 */
export function setupAuthServer(options: SetupAuthServerOptions): OAuthMetadata {
    const { authServerUrl, mcpServerUrl } = options;

    // Create better-auth instance with MCP plugin
    const auth = createDemoAuth({
        baseURL: authServerUrl.toString().replace(/\/$/, ''),
        resource: mcpServerUrl.toString(),
        loginPage: '/sign-in'
    });

    // Store globally for token verification
    globalAuth = auth;

    // Create Express app for auth server
    const authApp = express();
    authApp.use(express.json());
    authApp.use(express.urlencoded({ extended: true }));

    // Enable CORS for all origins (demo only)
    authApp.use((_req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.header('Access-Control-Expose-Headers', 'WWW-Authenticate');
        if (_req.method === 'OPTIONS') {
            res.sendStatus(200);
            return;
        }
        next();
    });

    // Auto-login page that immediately creates a session and redirects
    // This simulates a user logging in and approving the OAuth request
    authApp.get('/sign-in', async (req: Request, res: ExpressResponse) => {
        // Get the OAuth authorization parameters from the query string
        const queryParams = new URLSearchParams(req.query as Record<string, string>);
        const redirectUri = queryParams.get('redirect_uri');
        const clientId = queryParams.get('client_id');

        if (!redirectUri || !clientId) {
            res.status(400).send(`
                <!DOCTYPE html>
                <html>
                <head><title>Demo Login</title></head>
                <body>
                    <h1>Demo OAuth Server</h1>
                    <p>Missing required OAuth parameters. This page should be accessed via OAuth flow.</p>
                </body>
                </html>
            `);
            return;
        }

        // For demo: auto-approve by redirecting to the authorization endpoint
        // with a flag indicating auto-approval
        // In better-auth, we need to create a session first, then complete authorization

        // Set a demo session cookie
        const authCookieData = {
            userId: 'demo_user',
            name: 'Demo User',
            timestamp: Date.now()
        };
        const cookieValue = encodeURIComponent(JSON.stringify(authCookieData));
        res.cookie('demo_session', cookieValue, {
            httpOnly: true,
            sameSite: 'lax',
            maxAge: 24 * 60 * 60 * 1000 // 24 hours
        });

        // Redirect to the actual authorization handler with auto-approve
        // Better-auth handles the OAuth flow at /api/auth/authorize
        const authorizeUrl = new URL('/api/auth/authorize', authServerUrl);
        authorizeUrl.search = queryParams.toString();
        // Add a flag to indicate auto-approval (this would be handled by a custom flow)
        authorizeUrl.searchParams.set('auto_approve', 'true');

        console.log(`[Auth Server] Auto-approved login for client ${clientId}`);
        res.redirect(authorizeUrl.toString());
    });

    // Mount better-auth handler for all /api/auth/* routes
    // This handles: authorization, token, client registration, etc.
    authApp.all('/api/auth/*', toNodeHandler(auth));

    // OAuth metadata endpoints using better-auth's built-in handlers
    // See: https://www.better-auth.com/docs/plugins/mcp#oauth-discovery-metadata
    authApp.get('/.well-known/oauth-authorization-server', toNodeHandler(oAuthDiscoveryMetadata(auth)));
    authApp.get('/.well-known/oauth-protected-resource', toNodeHandler(oAuthProtectedResourceMetadata(auth)));

    // Start the auth server
    const authPort = parseInt(authServerUrl.port, 10);
    authApp.listen(authPort, (error?: Error) => {
        if (error) {
            console.error('Failed to start auth server:', error);
            process.exit(1);
        }
        console.log(`OAuth Authorization Server listening on port ${authPort}`);
        console.log(`  Authorization: ${authServerUrl}api/auth/authorize`);
        console.log(`  Token: ${authServerUrl}api/auth/token`);
        console.log(`  Metadata: ${authServerUrl}.well-known/oauth-authorization-server`);
    });

    return createOAuthMetadata(authServerUrl);
}

/**
 * Creates an Express router that serves OAuth Protected Resource Metadata
 * on the MCP server using better-auth's built-in handler.
 *
 * This is needed because MCP clients discover the auth server by first
 * fetching protected resource metadata from the MCP server.
 *
 * See: https://www.better-auth.com/docs/plugins/mcp#oauth-protected-resource-metadata
 */
export function createProtectedResourceMetadataRouter(): Router {
    const auth = getAuth();
    const router = express.Router();

    // Serve at the standard well-known path
    router.get('/.well-known/oauth-protected-resource', toNodeHandler(oAuthProtectedResourceMetadata(auth)));

    return router;
}

/**
 * Creates OAuth 2.0 Authorization Server Metadata (RFC 8414)
 */
function createOAuthMetadata(issuerUrl: URL): OAuthMetadata {
    const issuer = issuerUrl.toString().replace(/\/$/, '');
    const apiAuthBase = `${issuer}/api/auth`;

    return {
        issuer,
        authorization_endpoint: `${apiAuthBase}/authorize`,
        token_endpoint: `${apiAuthBase}/token`,
        registration_endpoint: `${apiAuthBase}/register`,
        introspection_endpoint: `${apiAuthBase}/introspect`,
        scopes_supported: ['openid', 'profile', 'email', 'offline_access', 'mcp:tools'],
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
        code_challenge_methods_supported: ['S256']
    };
}

/**
 * Verifies an access token using better-auth's getMcpSession.
 * This can be used by MCP servers to validate tokens.
 */
export async function verifyAccessToken(
    token: string,
    options?: { strictResource?: boolean; expectedResource?: URL }
): Promise<{
    token: string;
    clientId: string;
    scopes: string[];
    expiresAt: number;
}> {
    const auth = getAuth();

    try {
        // Create a mock request with the Authorization header
        const headers = new Headers();
        headers.set('Authorization', `Bearer ${token}`);

        // Use better-auth's getMcpSession API
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const session = await (auth.api as any).getMcpSession({
            headers
        });

        if (!session) {
            throw new Error('Invalid token');
        }

        // OAuthAccessToken has:
        // - accessToken, refreshToken: string
        // - accessTokenExpiresAt, refreshTokenExpiresAt: Date
        // - clientId, userId: string
        // - scopes: string (space-separated)
        const scopes = typeof session.scopes === 'string' ? session.scopes.split(' ') : ['openid'];
        const expiresAt = session.accessTokenExpiresAt
            ? Math.floor(new Date(session.accessTokenExpiresAt).getTime() / 1000)
            : Math.floor(Date.now() / 1000) + 3600;

        // Note: better-auth's OAuthAccessToken doesn't have a resource field
        // Resource validation would need to be done at a different layer
        if (options?.strictResource && options.expectedResource) {
            // For now, we skip resource validation as it's not in the session
            // In production, you'd store and validate this separately
            console.warn('[Auth] Resource validation requested but not available in better-auth session');
        }

        return {
            token,
            clientId: session.clientId,
            scopes,
            expiresAt
        };
    } catch (error) {
        throw new Error(`Token verification failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}
