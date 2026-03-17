/**
 * MCP Resource Server with External Auth Server
 *
 * DEMO ONLY - NOT FOR PRODUCTION
 *
 * An MCP server that validates JWT access tokens issued by an external
 * OAuth2 authorization server. The server:
 *
 * 1. Serves OAuth Protected Resource Metadata (RFC 9728) pointing clients
 *    to the external authorization server
 * 2. Validates JWT access tokens using the external AS's JWKS endpoint
 * 3. Checks the audience claim matches this resource (RFC 8707)
 *
 * Run the external auth server (authServer.ts) first, then start this server.
 */

import { randomUUID } from 'node:crypto';

import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/server';
import { isInitializeRequest, McpServer } from '@modelcontextprotocol/server';
import cors from 'cors';
import type { NextFunction, Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import * as z from 'zod/v4';

import { InMemoryEventStore } from '../inMemoryEventStore.js';

// --- Configuration ---

const MCP_PORT = process.env.MCP_PORT ? Number.parseInt(process.env.MCP_PORT, 10) : 3000;
const AUTH_SERVER_URL = process.env.AUTH_SERVER_URL || 'http://localhost:3001';
const MCP_SERVER_URL = `http://localhost:${MCP_PORT}/mcp`;

// --- JWT verification using external AS's JWKS ---

const JWKS = createRemoteJWKSet(new URL(`${AUTH_SERVER_URL}/jwks`));

/**
 * Express middleware that validates JWT Bearer tokens from the external AS.
 * Checks signature via JWKS, issuer, and audience (RFC 8707).
 */
function requireJwtAuth(expectedAudience: string) {
    const resourceMetadataUrl = `http://localhost:${MCP_PORT}/.well-known/oauth-protected-resource/mcp`;

    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            res.set(
                'WWW-Authenticate',
                `Bearer error="invalid_token", error_description="Missing Authorization header", resource_metadata="${resourceMetadataUrl}"`
            );
            res.status(401).json({
                error: 'invalid_token',
                error_description: 'Missing Authorization header'
            });
            return;
        }

        const token = authHeader.slice(7);

        try {
            const { payload } = await jwtVerify(token, JWKS, {
                issuer: AUTH_SERVER_URL,
                audience: expectedAudience
            });

            // Store verified token info for downstream handlers
            req.app.locals.auth = {
                sub: payload.sub,
                clientId: payload.client_id,
                scope: payload.scope,
                exp: payload.exp
            };

            console.log(`[MCP] Authenticated request: sub=${payload.sub}, scope=${payload.scope}`);
            next();
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Token verification failed';
            console.error(`[MCP] JWT verification failed: ${message}`);

            res.set(
                'WWW-Authenticate',
                `Bearer error="invalid_token", error_description="${message}", resource_metadata="${resourceMetadataUrl}"`
            );
            res.status(401).json({
                error: 'invalid_token',
                error_description: message
            });
        }
    };
}

// --- MCP Server setup ---

const getServer = () => {
    const server = new McpServer(
        {
            name: 'external-auth-example',
            version: '1.0.0'
        },
        {
            capabilities: { logging: {} }
        }
    );

    // A simple tool that returns a greeting (demonstrates authenticated access)
    server.registerTool(
        'greet',
        {
            title: 'Greeting Tool',
            description: 'A simple greeting tool (requires authentication)',
            inputSchema: z.object({
                name: z.string().describe('Name to greet')
            })
        },
        async ({ name }): Promise<CallToolResult> => {
            return {
                content: [{ type: 'text', text: `Hello, ${name}! (authenticated via external AS)` }]
            };
        }
    );

    // A tool that echoes the authenticated user's info
    server.registerTool(
        'whoami',
        {
            title: 'Who Am I',
            description: 'Returns information about the authenticated user from the JWT token',
            inputSchema: z.object({})
        },
        async (_args, _ctx): Promise<CallToolResult> => {
            // Note: In a real implementation, you would access auth context from the request.
            // This demo just confirms authentication succeeded.
            return {
                content: [
                    {
                        type: 'text',
                        text: 'You are authenticated via an external OAuth2 authorization server. Your JWT token was verified using the JWKS endpoint.'
                    }
                ]
            };
        }
    );

    // A simple resource
    server.registerResource(
        'auth-info',
        'https://example.com/auth-info',
        {
            title: 'Auth Info',
            description: 'Information about the authentication setup',
            mimeType: 'text/plain'
        },
        async (): Promise<ReadResourceResult> => {
            return {
                contents: [
                    {
                        uri: 'https://example.com/auth-info',
                        text: `This MCP server validates JWT tokens from ${AUTH_SERVER_URL}. Tokens are verified using the JWKS endpoint at ${AUTH_SERVER_URL}/jwks.`
                    }
                ]
            };
        }
    );

    return server;
};

// --- Express app ---

const app = createMcpExpressApp();

app.use(
    cors({
        exposedHeaders: ['WWW-Authenticate', 'Mcp-Session-Id', 'Last-Event-Id', 'Mcp-Protocol-Version'],
        origin: '*'
    })
);

// --- RFC 9728: OAuth Protected Resource Metadata ---
// This tells clients where to find the external authorization server.

app.get('/.well-known/oauth-protected-resource/mcp', cors(), (_req, res) => {
    res.json({
        resource: MCP_SERVER_URL,
        authorization_servers: [AUTH_SERVER_URL],
        scopes_supported: ['openid', 'profile', 'mcp:tools', 'mcp:resources'],
        bearer_methods_supported: ['header'],
        resource_name: 'MCP External Auth Example',
        resource_documentation: 'https://github.com/modelcontextprotocol/typescript-sdk'
    });
});

// --- MCP transport management ---

const transports: { [sessionId: string]: NodeStreamableHTTPServerTransport } = {};
const authMiddleware = requireJwtAuth(MCP_SERVER_URL);

// MCP POST endpoint (authenticated)
app.post('/mcp', authMiddleware, async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
        let transport: NodeStreamableHTTPServerTransport;
        if (sessionId && transports[sessionId]) {
            transport = transports[sessionId];
        } else if (!sessionId && isInitializeRequest(req.body)) {
            const eventStore = new InMemoryEventStore();
            transport = new NodeStreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                eventStore,
                onsessioninitialized: sid => {
                    console.log(`[MCP] Session initialized: ${sid}`);
                    transports[sid] = transport;
                }
            });

            transport.onclose = () => {
                const sid = transport.sessionId;
                if (sid && transports[sid]) {
                    console.log(`[MCP] Transport closed for session ${sid}`);
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

// MCP GET endpoint for SSE streams (authenticated)
app.get('/mcp', authMiddleware, async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
    }
    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
});

// MCP DELETE endpoint for session termination (authenticated)
app.delete('/mcp', authMiddleware, async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
    }
    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
});

// --- Start server ---

app.listen(MCP_PORT, error => {
    if (error) {
        console.error('Failed to start MCP server:', error);
        // eslint-disable-next-line unicorn/no-process-exit
        process.exit(1);
    }
    console.log(`MCP Resource Server listening on port ${MCP_PORT}`);
    console.log(`  MCP endpoint:             ${MCP_SERVER_URL}`);
    console.log(`  Protected Resource Meta:   http://localhost:${MCP_PORT}/.well-known/oauth-protected-resource/mcp`);
    console.log(`  External Auth Server:      ${AUTH_SERVER_URL}`);
    console.log();
    console.log('JWT tokens from the external AS are verified via JWKS.');
});

// --- Graceful shutdown ---

process.on('SIGINT', async () => {
    console.log('Shutting down MCP server...');
    for (const sessionId in transports) {
        try {
            await transports[sessionId]!.close();
            delete transports[sessionId];
        } catch (error) {
            console.error(`Error closing transport for session ${sessionId}:`, error);
        }
    }
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(0);
});
