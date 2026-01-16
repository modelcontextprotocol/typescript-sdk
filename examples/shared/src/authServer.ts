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

import { toNodeHandler } from 'better-auth/node';
import { oAuthDiscoveryMetadata, oAuthProtectedResourceMetadata } from 'better-auth/plugins';
import type { Request, Response as ExpressResponse, Router } from 'express';
import express from 'express';

import type { DemoAuth } from './auth.js';
import { createDemoAuth, DEMO_USER_CREDENTIALS } from './auth.js';

export interface SetupAuthServerOptions {
    authServerUrl: URL;
    mcpServerUrl: URL;
    strictResource?: boolean;
    /**
     * Examples should be used for **demo** only and not for production purposes, however this mode disables some logging and other features.
     */
    demoMode: boolean;
}

// Store auth instance globally so it can be used for token verification
let globalAuth: DemoAuth | null = null;
let demoUserCreated = false;

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
 * Ensures the demo user exists by calling signUpEmail (creates user with proper password hash)
 * Returns true if successful, false if user already exists (which is fine)
 */
async function ensureDemoUserExists(auth: DemoAuth): Promise<void> {
    if (demoUserCreated) return;

    try {
        // Try to sign up the demo user
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (auth.api as any).signUpEmail({
            body: {
                email: DEMO_USER_CREDENTIALS.email,
                password: DEMO_USER_CREDENTIALS.password,
                name: DEMO_USER_CREDENTIALS.name
            }
        });
        console.log('[Auth] Demo user created via signUpEmail');
        demoUserCreated = true;
    } catch (error) {
        // User might already exist, which is fine
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('already') || message.includes('exists') || message.includes('unique')) {
            console.log('[Auth] Demo user already exists');
            demoUserCreated = true;
        } else {
            console.error('[Auth] Failed to create demo user:', error);
            throw error;
        }
    }
}

/**
 * Sets up and starts the OAuth Authorization Server on a separate port.
 *
 * @param options - Server configuration
 */
export function setupAuthServer(options: SetupAuthServerOptions): void {
    const { authServerUrl, mcpServerUrl, demoMode } = options;

    // Create better-auth instance with MCP plugin
    const auth = createDemoAuth({
        baseURL: authServerUrl.toString().replace(/\/$/, ''),
        resource: mcpServerUrl.toString(),
        loginPage: '/sign-in',
        demoMode: demoMode
    });

    // Store globally for token verification
    globalAuth = auth;

    // Create Express app for auth server
    const authApp = express();

    // Enable CORS for all origins (demo only) - must be before other middleware
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

    // Request logging middleware for OAuth endpoints
    authApp.use('/api/auth', (req, res, next) => {
        const timestamp = new Date().toISOString();
        console.log(`${timestamp} [Auth Request] ${req.method} ${req.url}`);
        if (req.method === 'POST') {
            console.log(`${timestamp} [Auth Request] Content-Type: ${req.headers['content-type']}`);
        }

        if (demoMode) {
            // Log response when it finishes
            const originalSend = res.send.bind(res);
            res.send = function (body) {
                console.log(`${timestamp} [Auth Response] ${res.statusCode} ${req.url}`);
                if (res.statusCode >= 400 && body) {
                    try {
                        const parsed = typeof body === 'string' ? JSON.parse(body) : body;
                        console.log(`${timestamp} [Auth Response] Error:`, parsed);
                    } catch {
                        // Not JSON, log as-is if short
                        if (typeof body === 'string' && body.length < 200) {
                            console.log(`${timestamp} [Auth Response] Body: ${body}`);
                        }
                    }
                }
                return originalSend(body);
            };
        }
        next();
    });

    // Mount better-auth handler BEFORE body parsers
    // toNodeHandler reads the raw request body, so Express must not consume it first
    authApp.all('/api/auth/{*splat}', toNodeHandler(auth));

    // OAuth metadata endpoints using better-auth's built-in handlers
    authApp.get('/.well-known/oauth-authorization-server', toNodeHandler(oAuthDiscoveryMetadata(auth)));

    // Body parsers for non-better-auth routes (like /sign-in)
    authApp.use(express.json());
    authApp.use(express.urlencoded({ extended: true }));

    // Auto-login page that creates a real better-auth session
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

        try {
            // Ensure demo user exists (creates with proper password hash)
            await ensureDemoUserExists(auth);

            // Create a session using better-auth's signIn API with asResponse to get Set-Cookie headers
            const signInResponse = await auth.api.signInEmail({
                body: {
                    email: DEMO_USER_CREDENTIALS.email,
                    password: DEMO_USER_CREDENTIALS.password
                },
                asResponse: true
            });

            console.log('[Auth] Sign-in response status:', signInResponse.status);

            // Forward all Set-Cookie headers from better-auth's response
            const setCookieHeaders = signInResponse.headers.getSetCookie();
            console.log('[Auth] Set-Cookie headers:', setCookieHeaders);

            for (const cookie of setCookieHeaders) {
                res.append('Set-Cookie', cookie);
            }

            console.log(`[Auth Server] Session created, redirecting to authorize`);

            // Redirect to the authorization endpoint
            const authorizeUrl = new URL('/api/auth/mcp/authorize', authServerUrl);
            authorizeUrl.search = queryParams.toString();

            res.redirect(authorizeUrl.toString());
        } catch (error) {
            console.error('[Auth Server] Failed to create session:', error);
            res.status(500).send(`
                <!DOCTYPE html>
                <html>
                <head><title>Demo Login Error</title></head>
                <body>
                    <h1>Demo OAuth Server - Error</h1>
                    <p>Failed to create demo session: ${error instanceof Error ? error.message : 'Unknown error'}</p>
                    <pre>${error instanceof Error ? error.stack : ''}</pre>
                </body>
                </html>
            `);
        }
    });

    // Start the auth server
    const authPort = parseInt(authServerUrl.port, 10);
    authApp.listen(authPort, (error?: Error) => {
        if (error) {
            console.error('Failed to start auth server:', error);
            process.exit(1);
        }
        console.log(`OAuth Authorization Server listening on port ${authPort}`);
        console.log(`  Authorization: ${authServerUrl}api/auth/mcp/authorize`);
        console.log(`  Token: ${authServerUrl}api/auth/mcp/token`);
        console.log(`  Metadata: ${authServerUrl}.well-known/oauth-authorization-server`);
    });
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
