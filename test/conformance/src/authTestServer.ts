#!/usr/bin/env node

/**
 * MCP Auth Test Server - Conformance Test Server with Authentication
 *
 * A minimal MCP server that requires Bearer token authentication.
 * This server is used for testing OAuth authentication flows in conformance tests.
 *
 * Required environment variables:
 * - MCP_CONFORMANCE_AUTH_SERVER_URL: URL of the authorization server
 *
 * Optional environment variables:
 * - PORT: Server port (default: 3001)
 */

import { randomUUID } from 'node:crypto';

import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { isInitializeRequest, McpServer } from '@modelcontextprotocol/server';
import cors from 'cors';
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import * as z from 'zod/v4';

// Extend Express Request type to include auth info set by middleware
declare module 'express' {
    interface Request {
        auth?: AuthInfo;
    }
}

// Check for required environment variable
const AUTH_SERVER_URL = process.env.MCP_CONFORMANCE_AUTH_SERVER_URL;
if (!AUTH_SERVER_URL) {
    console.error('Error: MCP_CONFORMANCE_AUTH_SERVER_URL environment variable is required');
    console.error('Usage: MCP_CONFORMANCE_AUTH_SERVER_URL=http://localhost:3000 npx tsx authTestServer.ts');
    process.exit(1);
}

// Server configuration
const PORT = process.env.PORT || 3001;
const getBaseUrl = () => `http://localhost:${PORT}`;

// Session management
const transports: { [sessionId: string]: NodeStreamableHTTPServerTransport } = {};
const servers: { [sessionId: string]: McpServer } = {};

// Scope required for admin-action tool
const ADMIN_SCOPE = 'admin';

// Function to create a new MCP server instance (one per session)
function createMcpServer(): McpServer {
    const mcpServer = new McpServer(
        {
            name: 'mcp-auth-test-server',
            version: '1.0.0'
        },
        {
            capabilities: {
                tools: {}
            }
        }
    );

    // Simple echo tool for testing authenticated calls
    mcpServer.registerTool(
        'echo',
        {
            description: 'Echoes back the provided message - used for testing authenticated calls',
            inputSchema: z.object({
                message: z.string().optional().describe('The message to echo back')
            })
        },
        async (args: { message?: string }) => {
            const message = args.message || 'No message provided';
            return {
                content: [{ type: 'text', text: `Echo: ${message}` }]
            };
        }
    );

    // Simple test tool with no arguments
    mcpServer.registerTool(
        'test-tool',
        {
            description: 'A simple test tool that returns a success message'
        },
        async () => {
            return {
                content: [{ type: 'text', text: 'test' }]
            };
        }
    );

    // Privileged tool requiring 'admin' scope - for step-up auth testing
    mcpServer.registerTool(
        'admin-action',
        {
            description: 'A privileged action that requires admin scope - used for step-up auth testing',
            inputSchema: z.object({
                action: z.string().optional().describe('The admin action to perform')
            })
        },
        async (args: { action?: string }) => {
            const action = args.action || 'default-admin-action';
            return {
                content: [{ type: 'text', text: `Admin action performed: ${action}` }]
            };
        }
    );

    return mcpServer;
}

/**
 * Fetches the authorization server metadata to get the introspection endpoint.
 */
async function fetchAuthServerMetadata(): Promise<{ introspection_endpoint?: string }> {
    const metadataUrl = `${AUTH_SERVER_URL}/.well-known/oauth-authorization-server`;
    const response = await fetch(metadataUrl);
    if (!response.ok) {
        throw new Error(`Failed to fetch AS metadata: ${response.status}`);
    }
    return response.json() as Promise<{ introspection_endpoint?: string }>;
}

/**
 * Verifies a token via the authorization server's introspection endpoint (RFC 7662).
 */
async function introspectToken(introspectionEndpoint: string, token: string): Promise<AuthInfo> {
    const response = await fetch(introspectionEndpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ token }).toString()
    });

    if (!response.ok) {
        throw new Error('Token introspection failed');
    }

    const data = (await response.json()) as {
        active: boolean;
        client_id?: string;
        scope?: string;
        exp?: number;
    };

    if (!data.active) {
        throw new Error('Token is not active');
    }

    return {
        token,
        clientId: data.client_id || 'unknown',
        scopes: data.scope ? data.scope.split(' ') : [],
        expiresAt: data.exp || Math.floor(Date.now() / 1000) + 3600
    };
}

/**
 * Express middleware that requires a valid Bearer token.
 * Validates via the authorization server's introspection endpoint and sets req.auth.
 */
function requireBearerAuth(introspectionEndpoint: string, prmUrl: string) {
    const buildWwwAuthHeader = (errorCode: string, message: string): string => {
        return `Bearer error="${errorCode}", error_description="${message}", resource_metadata="${prmUrl}"`;
    };

    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            res.set('WWW-Authenticate', buildWwwAuthHeader('invalid_token', 'Missing Authorization header'));
            res.status(401).json({
                error: 'invalid_token',
                error_description: 'Missing Authorization header'
            });
            return;
        }

        const token = authHeader.slice(7); // Remove 'Bearer ' prefix

        try {
            req.auth = await introspectToken(introspectionEndpoint, token);
            next();
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Invalid token';
            res.set('WWW-Authenticate', buildWwwAuthHeader('invalid_token', message));
            res.status(401).json({
                error: 'invalid_token',
                error_description: message
            });
        }
    };
}

// Helper to check if request is a tools/call for admin-action
function isAdminToolCall(body: unknown): boolean {
    if (typeof body !== 'object' || body === null || !('method' in body) || !('params' in body)) {
        return false;
    }
    const { method, params } = body as { method: string; params: unknown };
    if (method !== 'tools/call') {
        return false;
    }
    if (typeof params !== 'object' || params === null || !('name' in params)) {
        return false;
    }
    return (params as { name: string }).name === 'admin-action';
}

/**
 * Middleware to check for admin scope on privileged tool calls.
 * Returns 403 insufficient_scope if the token doesn't have admin scope.
 */
function checkAdminScope(prmUrl: string) {
    return (req: Request, res: Response, next: NextFunction): void => {
        // Only check for tools/call with admin-action
        if (!isAdminToolCall(req.body)) {
            return next();
        }

        // req.auth is set by requireBearerAuth middleware
        const scopes = req.auth?.scopes || [];

        if (!scopes.includes(ADMIN_SCOPE)) {
            // Return 403 with insufficient_scope error
            res.setHeader(
                'WWW-Authenticate',
                `Bearer error="insufficient_scope", ` +
                    `scope="${ADMIN_SCOPE}", ` +
                    `resource_metadata="${prmUrl}", ` +
                    `error_description="The admin-action tool requires admin scope"`
            );
            res.status(403).json({
                error: 'insufficient_scope',
                error_description: 'The admin-action tool requires admin scope'
            });
            return;
        }

        next();
    };
}

// ===== EXPRESS APP =====

async function startServer() {
    // Fetch AS metadata to get introspection endpoint
    console.log(`Fetching authorization server metadata from ${AUTH_SERVER_URL}...`);
    const asMetadata = await fetchAuthServerMetadata();

    if (!asMetadata.introspection_endpoint) {
        console.error('Error: Authorization server does not provide introspection_endpoint');
        process.exit(1);
    }

    console.log(`Using introspection endpoint: ${asMetadata.introspection_endpoint}`);

    // Create bearer auth middleware
    const prmUrl = `${getBaseUrl()}/.well-known/oauth-protected-resource`;
    const bearerAuth = requireBearerAuth(asMetadata.introspection_endpoint, prmUrl);

    // Create scope-checking middleware for privileged tools
    const adminScopeCheck = checkAdminScope(prmUrl);

    const app = express();
    app.use(express.json());

    // Configure CORS to expose Mcp-Session-Id header for browser-based clients
    app.use(
        cors({
            origin: '*',
            exposedHeaders: ['Mcp-Session-Id'],
            allowedHeaders: ['Content-Type', 'mcp-session-id', 'last-event-id', 'Authorization']
        })
    );

    // Protected Resource Metadata endpoint (RFC 9728)
    app.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
        res.json({
            resource: getBaseUrl(),
            authorization_servers: [AUTH_SERVER_URL],
            // List supported scopes for step-up auth testing
            scopes_supported: [ADMIN_SCOPE]
        });
    });

    // Handle POST requests to /mcp with bearer auth and scope checking
    app.post('/mcp', bearerAuth, adminScopeCheck, async (req: Request, res: Response) => {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;

        try {
            let transport: NodeStreamableHTTPServerTransport;

            if (sessionId && transports[sessionId]) {
                // Reuse existing transport for established sessions
                transport = transports[sessionId];
            } else if (!sessionId && isInitializeRequest(req.body)) {
                // Create new transport for initialization requests
                const mcpServer = createMcpServer();

                transport = new NodeStreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    onsessioninitialized: (newSessionId: string) => {
                        transports[newSessionId] = transport;
                        servers[newSessionId] = mcpServer;
                        console.log(`Session initialized with ID: ${newSessionId}`);
                    }
                });

                transport.onclose = () => {
                    const sid = transport.sessionId;
                    if (sid && transports[sid]) {
                        delete transports[sid];
                        if (servers[sid]) {
                            servers[sid].close();
                            delete servers[sid];
                        }
                        console.log(`Session ${sid} closed`);
                    }
                };

                await mcpServer.connect(transport);
                await transport.handleRequest(req, res, req.body);
                return;
            } else if (sessionId) {
                res.status(404).json({
                    jsonrpc: '2.0',
                    error: { code: -32_001, message: 'Session not found' },
                    id: null
                });
                return;
            } else {
                res.status(400).json({
                    jsonrpc: '2.0',
                    error: { code: -32_000, message: 'Bad Request: Session ID required' },
                    id: null
                });
                return;
            }

            await transport.handleRequest(req, res, req.body);
        } catch (error) {
            console.error('Error handling MCP request:', error);
            if (!res.headersSent) {
                res.status(500).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32_603,
                        message: 'Internal server error'
                    },
                    id: null
                });
            }
        }
    });

    // Handle GET requests - SSE streams for sessions (also requires auth)
    app.get('/mcp', bearerAuth, async (req: Request, res: Response) => {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;

        if (!sessionId) {
            res.status(400).send('Missing session ID');
            return;
        }
        if (!transports[sessionId]) {
            res.status(404).send('Session not found');
            return;
        }

        console.log(`Establishing SSE stream for session ${sessionId}`);

        try {
            const transport = transports[sessionId];
            await transport.handleRequest(req, res);
        } catch (error) {
            console.error('Error handling SSE stream:', error);
            if (!res.headersSent) {
                res.status(500).send('Error establishing SSE stream');
            }
        }
    });

    // Handle DELETE requests - session termination (also requires auth)
    app.delete('/mcp', bearerAuth, async (req: Request, res: Response) => {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;

        if (!sessionId) {
            res.status(400).send('Missing session ID');
            return;
        }
        if (!transports[sessionId]) {
            res.status(404).send('Session not found');
            return;
        }

        console.log(`Received session termination request for session ${sessionId}`);

        try {
            const transport = transports[sessionId];
            await transport.handleRequest(req, res);
        } catch (error) {
            console.error('Error handling termination:', error);
            if (!res.headersSent) {
                res.status(500).send('Error processing session termination');
            }
        }
    });

    // Start server
    app.listen(PORT, () => {
        console.log(`MCP Auth Test Server running at http://localhost:${PORT}/mcp`);
        console.log(`  - PRM endpoint: http://localhost:${PORT}/.well-known/oauth-protected-resource`);
        console.log(`  - Auth server: ${AUTH_SERVER_URL}`);
        console.log(`  - Introspection: ${asMetadata.introspection_endpoint}`);
    });
}

// Start the server
try {
    await startServer();
} catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
}
