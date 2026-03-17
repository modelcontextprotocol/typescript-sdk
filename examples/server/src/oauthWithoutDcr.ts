#!/usr/bin/env node

/**
 * OAuth Without Dynamic Client Registration (DCR) Example
 *
 * Demonstrates how to build an MCP server that authenticates users via an
 * upstream OAuth provider (e.g., GitHub, Google) that does NOT support
 * Dynamic Client Registration (RFC 7591).
 *
 * The pattern: the MCP server acts as an OAuth Authorization Server proxy.
 * MCP clients discover and interact with this proxy using standard MCP OAuth
 * flows (including DCR). The proxy then handles the actual authentication
 * against the upstream provider using pre-registered credentials.
 *
 * Architecture:
 *
 *   MCP Client  <-->  MCP Server (OAuth Proxy)  <-->  Upstream OAuth Provider
 *                     - Accepts DCR from clients       (GitHub, Google, etc.)
 *                     - Proxies auth to upstream        - No DCR support
 *                     - Uses pre-registered creds       - Pre-registered app
 *
 * Required environment variables:
 *   OAUTH_CLIENT_ID       - Client ID from upstream provider
 *   OAUTH_CLIENT_SECRET   - Client secret from upstream provider
 *
 * Optional environment variables:
 *   MCP_PORT              - Port for MCP server (default: 3000)
 *   PROXY_PORT            - Port for OAuth proxy server (default: 3001)
 *   OAUTH_AUTHORIZE_URL   - Upstream authorize endpoint
 *                            (default: https://github.com/login/oauth/authorize)
 *   OAUTH_TOKEN_URL       - Upstream token endpoint
 *                            (default: https://github.com/login/oauth/access_token)
 *   OAUTH_SCOPES          - Space-separated scopes to request from upstream
 *                            (default: "read:user user:email")
 *
 * Usage:
 *   OAUTH_CLIENT_ID=xxx OAUTH_CLIENT_SECRET=yyy tsx src/oauthWithoutDCR.ts
 *
 * Then connect with the example client:
 *   pnpm --filter @modelcontextprotocol/examples-client exec tsx src/simpleOAuthClient.ts
 */

import { randomBytes, randomUUID } from 'node:crypto';

import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/server';
import { isInitializeRequest, McpServer } from '@modelcontextprotocol/server';
import cors from 'cors';
import type { Request, Response } from 'express';
import express from 'express';
import * as z from 'zod/v4';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET;

if (!OAUTH_CLIENT_ID || !OAUTH_CLIENT_SECRET) {
    console.error('Required environment variables: OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET');
    console.error('');
    console.error('These are the credentials from your upstream OAuth provider (e.g., a GitHub OAuth App).');
    console.error('Register an app at https://github.com/settings/developers and set these values.');
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(1);
}

const MCP_PORT = process.env.MCP_PORT ? Number.parseInt(process.env.MCP_PORT, 10) : 3000;
const PROXY_PORT = process.env.PROXY_PORT ? Number.parseInt(process.env.PROXY_PORT, 10) : 3001;
const OAUTH_AUTHORIZE_URL = process.env.OAUTH_AUTHORIZE_URL ?? 'https://github.com/login/oauth/authorize';
const OAUTH_TOKEN_URL = process.env.OAUTH_TOKEN_URL ?? 'https://github.com/login/oauth/access_token';
const OAUTH_SCOPES = process.env.OAUTH_SCOPES ?? 'read:user user:email';

const proxyBaseUrl = `http://localhost:${PROXY_PORT}`;
const mcpBaseUrl = `http://localhost:${MCP_PORT}`;

// ---------------------------------------------------------------------------
// In-memory stores (demo only; use a database in production)
// ---------------------------------------------------------------------------

/** Registered MCP clients (from DCR). Maps client_id to client info. */
const registeredClients = new Map<string, { client_id: string; client_secret: string; redirect_uris: string[] }>();

/** Pending authorization requests. Maps state to { client redirect_uri, client_id, code_challenge, etc. } */
const pendingAuthorizations = new Map<
    string,
    {
        clientId: string;
        redirectUri: string;
        codeChallenge?: string;
        codeChallengeMethod?: string;
        scope?: string;
    }
>();

/** Issued authorization codes. Maps code to { upstream access_token, client_id }. */
const issuedCodes = new Map<string, { upstreamAccessToken: string; clientId: string }>();

/** Issued access tokens. Maps token to { upstream access_token, client_id, scopes }. */
const issuedTokens = new Map<string, { upstreamAccessToken: string; clientId: string; scopes: string }>();

// ---------------------------------------------------------------------------
// OAuth Proxy Server
//
// This server acts as an OAuth Authorization Server from the MCP client's
// perspective. It handles:
//   - /.well-known/oauth-authorization-server  (metadata discovery)
//   - /register  (Dynamic Client Registration for MCP clients)
//   - /authorize (redirects to upstream provider)
//   - /callback  (receives upstream callback, issues code to MCP client)
//   - /token     (exchanges code for access token)
// ---------------------------------------------------------------------------

function startOAuthProxy(): void {
    const proxyApp = express();

    proxyApp.use(
        cors({
            origin: '*' // WARNING: restrict in production
        })
    );
    proxyApp.use(express.json());
    proxyApp.use(express.urlencoded({ extended: true }));

    // ---- OAuth Authorization Server Metadata (RFC 8414) ----
    proxyApp.get('/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
        res.json({
            issuer: proxyBaseUrl,
            authorization_endpoint: `${proxyBaseUrl}/authorize`,
            token_endpoint: `${proxyBaseUrl}/token`,
            registration_endpoint: `${proxyBaseUrl}/register`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
            code_challenge_methods_supported: ['S256'],
            scopes_supported: OAUTH_SCOPES.split(' ')
        });
    });

    // ---- Dynamic Client Registration (RFC 7591) ----
    // MCP clients call this to register themselves. Since the upstream provider
    // doesn't support DCR, we handle it here and issue our own client credentials.
    proxyApp.post('/register', (req: Request, res: Response) => {
        const { redirect_uris, client_name } = req.body;

        if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
            res.status(400).json({
                error: 'invalid_client_metadata',
                error_description: 'redirect_uris is required'
            });
            return;
        }

        const clientId = `mcp-client-${randomUUID()}`;
        const clientSecret = randomBytes(32).toString('hex');

        registeredClients.set(clientId, {
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uris
        });

        console.log(`[Proxy] Registered new MCP client: ${clientId} (${client_name ?? 'unnamed'})`);

        res.status(201).json({
            client_id: clientId,
            client_secret: clientSecret,
            client_name: client_name ?? undefined,
            redirect_uris,
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'client_secret_post'
        });
    });

    // ---- Authorization Endpoint ----
    // MCP client redirects the user here. We store the request details and
    // redirect the user to the upstream provider's authorization endpoint.
    proxyApp.get('/authorize', (req: Request, res: Response) => {
        const { client_id, redirect_uri, state, code_challenge, code_challenge_method, scope } = req.query as Record<string, string>;

        if (!client_id || !redirect_uri) {
            res.status(400).send('Missing required parameters: client_id, redirect_uri');
            return;
        }

        // Verify the client is registered
        const client = registeredClients.get(client_id);
        if (!client) {
            res.status(400).send('Unknown client_id. Did the client register via /register first?');
            return;
        }

        // Verify redirect_uri matches
        if (!client.redirect_uris.includes(redirect_uri)) {
            res.status(400).send('redirect_uri does not match registered URIs');
            return;
        }

        // Generate a unique state to correlate the upstream callback
        const proxyState = randomBytes(16).toString('hex');

        // Store the pending authorization so we can complete it on callback
        pendingAuthorizations.set(proxyState, {
            clientId: client_id,
            redirectUri: redirect_uri,
            codeChallenge: code_challenge,
            codeChallengeMethod: code_challenge_method,
            scope: scope ?? OAUTH_SCOPES
        });

        // Build the upstream authorization URL using the pre-registered credentials
        const upstreamUrl = new URL(OAUTH_AUTHORIZE_URL);
        upstreamUrl.searchParams.set('client_id', OAUTH_CLIENT_ID!);
        upstreamUrl.searchParams.set('redirect_uri', `${proxyBaseUrl}/callback`);
        upstreamUrl.searchParams.set('scope', scope ?? OAUTH_SCOPES);
        upstreamUrl.searchParams.set('state', proxyState);

        // Store the original state from the MCP client so we can forward it back
        if (state) {
            pendingAuthorizations.get(proxyState)!.scope = `${pendingAuthorizations.get(proxyState)!.scope ?? ''}`;
            // We'll store the original MCP client state in a secondary map
            pendingAuthorizations.set(`original_state_${proxyState}`, {
                clientId: state,
                redirectUri: redirect_uri,
                scope
            });
        }

        console.log(`[Proxy] Redirecting user to upstream provider for client ${client_id}`);
        res.redirect(upstreamUrl.toString());
    });

    // ---- Upstream Callback ----
    // The upstream provider redirects here after user authorization.
    // We exchange the upstream code for an upstream token, then issue our own
    // authorization code to the MCP client.
    proxyApp.get('/callback', async (req: Request, res: Response) => {
        const { code, state: proxyState, error } = req.query as Record<string, string>;

        if (error) {
            console.error(`[Proxy] Upstream authorization error: ${error}`);
            res.status(400).send(`Upstream authorization failed: ${error}`);
            return;
        }

        if (!code || !proxyState) {
            res.status(400).send('Missing code or state parameter');
            return;
        }

        const pending = pendingAuthorizations.get(proxyState);
        if (!pending) {
            res.status(400).send('Unknown or expired authorization state');
            return;
        }

        try {
            // Exchange the upstream code for an upstream access token
            const tokenResponse = await fetch(OAUTH_TOKEN_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json'
                },
                body: JSON.stringify({
                    client_id: OAUTH_CLIENT_ID,
                    client_secret: OAUTH_CLIENT_SECRET,
                    code,
                    redirect_uri: `${proxyBaseUrl}/callback`
                })
            });

            const tokenData = (await tokenResponse.json()) as { access_token?: string; error?: string; error_description?: string };

            if (!tokenData.access_token) {
                console.error('[Proxy] Failed to exchange upstream code:', tokenData);
                res.status(500).send(
                    `Failed to exchange code with upstream: ${tokenData.error_description ?? tokenData.error ?? 'unknown error'}`
                );
                return;
            }

            // Issue our own authorization code to the MCP client
            const mcpCode = randomBytes(32).toString('hex');
            issuedCodes.set(mcpCode, {
                upstreamAccessToken: tokenData.access_token,
                clientId: pending.clientId
            });

            // Clean up pending state
            pendingAuthorizations.delete(proxyState);

            // Redirect back to the MCP client with our authorization code
            const clientRedirect = new URL(pending.redirectUri);
            clientRedirect.searchParams.set('code', mcpCode);

            // Forward the original state if present
            const originalStateEntry = pendingAuthorizations.get(`original_state_${proxyState}`);
            if (originalStateEntry) {
                clientRedirect.searchParams.set('state', originalStateEntry.clientId);
                pendingAuthorizations.delete(`original_state_${proxyState}`);
            }

            console.log(`[Proxy] Upstream auth successful, redirecting to MCP client`);
            res.redirect(clientRedirect.toString());
        } catch (fetchError) {
            console.error('[Proxy] Error exchanging upstream code:', fetchError);
            res.status(500).send('Internal error during token exchange');
        }
    });

    // ---- Token Endpoint ----
    // MCP client exchanges its authorization code for an access token.
    proxyApp.post('/token', (req: Request, res: Response) => {
        const { grant_type, code, client_id, client_secret } = req.body;

        // Authenticate the MCP client
        let authenticatedClientId = client_id;

        // Support client_secret_basic (Authorization header)
        const authHeader = req.headers.authorization;
        if (authHeader?.startsWith('Basic ')) {
            const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
            const [basicClientId, basicSecret] = decoded.split(':');
            authenticatedClientId = basicClientId;
            const client = registeredClients.get(basicClientId!);
            if (!client || client.client_secret !== basicSecret) {
                res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client credentials' });
                return;
            }
        } else if (client_id) {
            // Support client_secret_post
            const client = registeredClients.get(client_id);
            if (!client || (client.client_secret !== client_secret && client_secret !== undefined)) {
                res.status(401).json({ error: 'invalid_client', error_description: 'Invalid client credentials' });
                return;
            }
        }

        if (grant_type === 'authorization_code') {
            if (!code) {
                res.status(400).json({ error: 'invalid_request', error_description: 'Missing authorization code' });
                return;
            }

            const codeEntry = issuedCodes.get(code);
            if (!codeEntry) {
                res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid or expired authorization code' });
                return;
            }

            // Verify the code was issued for this client
            if (codeEntry.clientId !== authenticatedClientId) {
                res.status(400).json({ error: 'invalid_grant', error_description: 'Code was not issued for this client' });
                return;
            }

            // Issue our own access token (maps to the upstream token internally)
            const accessToken = randomBytes(32).toString('hex');
            issuedTokens.set(accessToken, {
                upstreamAccessToken: codeEntry.upstreamAccessToken,
                clientId: codeEntry.clientId,
                scopes: OAUTH_SCOPES
            });

            // Clean up used code
            issuedCodes.delete(code);

            console.log(`[Proxy] Issued access token for client ${authenticatedClientId}`);

            res.json({
                access_token: accessToken,
                token_type: 'bearer',
                expires_in: 3600,
                scope: OAUTH_SCOPES
            });
        } else if (grant_type === 'refresh_token') {
            // Simplified: in production, implement proper refresh token handling
            res.status(400).json({ error: 'unsupported_grant_type', error_description: 'Refresh tokens not implemented in this demo' });
        } else {
            res.status(400).json({ error: 'unsupported_grant_type', error_description: `Unsupported grant_type: ${grant_type}` });
        }
    });

    proxyApp.listen(PROXY_PORT, (error?: Error) => {
        if (error) {
            console.error('Failed to start OAuth proxy:', error);
            // eslint-disable-next-line unicorn/no-process-exit
            process.exit(1);
        }
        console.log(`OAuth Proxy Server listening on port ${PROXY_PORT}`);
        console.log(`  Metadata:  ${proxyBaseUrl}/.well-known/oauth-authorization-server`);
        console.log(`  Register:  ${proxyBaseUrl}/register`);
        console.log(`  Authorize: ${proxyBaseUrl}/authorize`);
        console.log(`  Token:     ${proxyBaseUrl}/token`);
        console.log(`  Callback:  ${proxyBaseUrl}/callback (for upstream provider)`);
    });
}

// ---------------------------------------------------------------------------
// Token verification helper
// ---------------------------------------------------------------------------

function verifyToken(token: string): { clientId: string; scopes: string; upstreamAccessToken: string } | undefined {
    return issuedTokens.get(token);
}

// ---------------------------------------------------------------------------
// Bearer auth middleware for the MCP server
// ---------------------------------------------------------------------------

function requireBearerAuth(req: Request, res: Response, next: () => void): void {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
        const metadataUrl = `${mcpBaseUrl}/.well-known/oauth-protected-resource/mcp`;
        res.set(
            'WWW-Authenticate',
            `Bearer error="invalid_token", error_description="Missing Authorization header", resource_metadata="${metadataUrl}"`
        );
        res.status(401).json({ error: 'invalid_token', error_description: 'Missing Authorization header' });
        return;
    }

    const token = authHeader.slice(7);
    const tokenInfo = verifyToken(token);

    if (!tokenInfo) {
        res.set('WWW-Authenticate', 'Bearer error="invalid_token", error_description="Invalid or expired token"');
        res.status(401).json({ error: 'invalid_token', error_description: 'Invalid or expired token' });
        return;
    }

    // Attach token info for use in request handlers
    req.app.locals.auth = tokenInfo;
    next();
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

function getServer(): McpServer {
    const server = new McpServer(
        {
            name: 'oauth-no-dcr-example',
            version: '1.0.0'
        },
        { capabilities: { logging: {} } }
    );

    // A simple tool demonstrating that auth-protected access works
    server.registerTool(
        'greet',
        {
            title: 'Greeting Tool',
            description: 'A simple greeting tool (demonstrates basic auth-protected access)',
            inputSchema: z.object({
                name: z.string().describe('Name to greet')
            })
        },
        async ({ name }): Promise<CallToolResult> => {
            return {
                content: [{ type: 'text', text: `Hello, ${name}! You are authenticated via the OAuth proxy.` }]
            };
        }
    );

    // A resource showing the auth architecture
    server.registerResource(
        'auth-info',
        'info://auth-architecture',
        {
            title: 'Authentication Architecture',
            description: 'Describes how this server handles OAuth without DCR support from the upstream provider',
            mimeType: 'text/plain'
        },
        async (): Promise<ReadResourceResult> => {
            return {
                contents: [
                    {
                        uri: 'info://auth-architecture',
                        text: [
                            'OAuth Without DCR - Architecture',
                            '================================',
                            '',
                            'This MCP server uses a proxy pattern to handle OAuth authentication',
                            'against upstream providers that do not support Dynamic Client Registration.',
                            '',
                            'Flow:',
                            '1. MCP client discovers the proxy via /.well-known/oauth-protected-resource',
                            '2. Client registers via DCR at the proxy /register endpoint',
                            '3. Client redirects user to proxy /authorize',
                            '4. Proxy redirects user to upstream provider (e.g., GitHub)',
                            '5. User authenticates and authorizes at the upstream provider',
                            '6. Upstream redirects to proxy /callback with an authorization code',
                            '7. Proxy exchanges the code for an upstream access token',
                            '8. Proxy issues its own authorization code back to the MCP client',
                            '9. MCP client exchanges the proxy code at /token',
                            '10. Proxy issues its own access token (mapped to the upstream token)',
                            '',
                            'The MCP client never interacts directly with the upstream provider.',
                            'The proxy manages the upstream credentials (client_id, client_secret)',
                            'from environment variables.'
                        ].join('\n')
                    }
                ]
            };
        }
    );

    return server;
}

// ---------------------------------------------------------------------------
// MCP HTTP Server with auth
// ---------------------------------------------------------------------------

const app = createMcpExpressApp();

app.use(
    cors({
        exposedHeaders: ['WWW-Authenticate', 'Mcp-Session-Id', 'Last-Event-Id', 'Mcp-Protocol-Version'],
        origin: '*' // WARNING: restrict in production
    })
);

// Protected Resource Metadata (RFC 9728)
// Tells MCP clients where to find the OAuth Authorization Server
app.get('/.well-known/oauth-protected-resource/mcp', (_req: Request, res: Response) => {
    res.json({
        resource: `${mcpBaseUrl}/mcp`,
        authorization_servers: [proxyBaseUrl],
        scopes_supported: OAUTH_SCOPES.split(' ')
    });
});

// Map to store transports by session ID
const transports: Record<string, NodeStreamableHTTPServerTransport> = {};

// MCP POST endpoint (auth-protected)
app.post('/mcp', requireBearerAuth, async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
        let transport: NodeStreamableHTTPServerTransport;

        if (sessionId && transports[sessionId]) {
            transport = transports[sessionId];
        } else if (!sessionId && isInitializeRequest(req.body)) {
            transport = new NodeStreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: sid => {
                    console.log(`[MCP] Session initialized: ${sid}`);
                    transports[sid] = transport;
                }
            });

            transport.onclose = () => {
                const sid = transport.sessionId;
                if (sid && transports[sid]) {
                    delete transports[sid];
                }
            };

            const server = getServer();
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
            return;
        } else {
            res.status(400).json({
                jsonrpc: '2.0',
                error: { code: -32_000, message: 'Bad Request: No valid session ID provided' },
                id: null
            });
            return;
        }

        await transport.handleRequest(req, res, req.body);
    } catch (error) {
        console.error('[MCP] Error handling request:', error);
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: '2.0',
                error: { code: -32_603, message: 'Internal server error' },
                id: null
            });
        }
    }
});

// MCP GET endpoint for SSE streams
app.get('/mcp', requireBearerAuth, async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
    }
    await transports[sessionId].handleRequest(req, res);
});

// MCP DELETE endpoint for session termination
app.delete('/mcp', requireBearerAuth, async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
    }
    await transports[sessionId].handleRequest(req, res);
});

// ---------------------------------------------------------------------------
// Start both servers
// ---------------------------------------------------------------------------

startOAuthProxy();

app.listen(MCP_PORT, (error?: Error) => {
    if (error) {
        console.error('Failed to start MCP server:', error);
        // eslint-disable-next-line unicorn/no-process-exit
        process.exit(1);
    }
    console.log(`\nMCP Server listening on port ${MCP_PORT}`);
    console.log(`  MCP endpoint: ${mcpBaseUrl}/mcp`);
    console.log(`  Protected Resource Metadata: ${mcpBaseUrl}/.well-known/oauth-protected-resource/mcp`);
    console.log(`\nConnect with an MCP client that supports OAuth.`);
    console.log(`The client will automatically discover the OAuth proxy via the protected resource metadata.`);
});

process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    for (const sessionId in transports) {
        try {
            await transports[sessionId]!.close();
            delete transports[sessionId];
        } catch (error) {
            console.error(`Error closing session ${sessionId}:`, error);
        }
    }
    process.exit(0);
});
