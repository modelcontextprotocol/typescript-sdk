import { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '../../server/mcp.js';
import { StreamableHTTPServerTransport } from '../../server/streamableHttp.js';
import { SSEServerTransport } from '../../server/sse.js';
import * as z from 'zod/v4';
import { CallToolResult, isInitializeRequest } from '../../types.js';
import { InMemoryEventStore } from '../shared/inMemoryEventStore.js';
import { createMcpExpressApp } from '../../server/express.js';

/**
 * This example server demonstrates backwards compatibility with both:
 * 1. The deprecated HTTP+SSE transport (protocol version 2024-11-05)
 * 2. The Streamable HTTP transport (protocol version 2025-11-25)
 *
 * It maintains a single MCP server instance but exposes two transport options:
 * - /mcp: The new Streamable HTTP endpoint (supports GET/POST/DELETE)
 * - /sse: The deprecated SSE endpoint for older clients (GET to establish stream)
 * - /messages: The deprecated POST endpoint for older clients (POST to send messages)
 */

const getServer = () => {
    const server = new McpServer(
        {
            name: 'backwards-compatible-server',
            version: '1.0.0'
        },
        { capabilities: { logging: {} } }
    );

    // Register a simple tool that sends notifications over time
    server.registerTool(
        'start-notification-stream',
        {
            description: 'Starts sending periodic notifications for testing resumability',
            inputSchema: {
                interval: z.number().describe('Interval in milliseconds between notifications').default(100),
                count: z.number().describe('Number of notifications to send (0 for 100)').default(50)
            }
        },
        async ({ interval, count }, extra): Promise<CallToolResult> => {
            const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
            let counter = 0;

            while (count === 0 || counter < count) {
                counter++;
                try {
                    await server.sendLoggingMessage(
                        {
                            level: 'info',
                            data: `Periodic notification #${counter} at ${new Date().toISOString()}`
                        },
                        extra.sessionId
                    );
                } catch (error) {
                    console.error('Error sending notification:', error);
                }
                // Wait for the specified interval
                await sleep(interval);
            }

            return {
                content: [
                    {
                        type: 'text',
                        text: `Started sending periodic notifications every ${interval}ms`
                    }
                ]
            };
        }
    );
    return server;
};

// Create Express application
const app = createMcpExpressApp();

// Close sessions that have been idle for IDLE_MS, and keep at most MAX_SESSIONS open
const IDLE_MS = 30 * 60_000;
const MAX_SESSIONS = 10_000;

// Store sessions by session ID
type Session = { transport: StreamableHTTPServerTransport | SSEServerTransport; open: number; lastActive: number };
const sessions = new Map<string, Session>();

// Count open responses so a long-running request or a listening SSE stream is not treated as idle
const trackResponse = (session: Session, res: Response) => {
    if (!res.socket || res.destroyed) return;
    session.open++;
    res.on('close', () => {
        session.open--;
        session.lastActive = Date.now();
    });
};

// Close sessions with nothing open and no activity for IDLE_MS
setInterval(() => {
    const cutoff = Date.now() - IDLE_MS;
    for (const { transport, open, lastActive } of sessions.values()) {
        if (open === 0 && lastActive < cutoff) void transport.close();
    }
}, 60_000).unref();

//=============================================================================
// STREAMABLE HTTP TRANSPORT (PROTOCOL VERSION 2025-11-25)
//=============================================================================

// Handle all MCP Streamable HTTP requests (GET, POST, DELETE) on a single endpoint
app.all('/mcp', async (req: Request, res: Response) => {
    console.log(`Received ${req.method} request to /mcp`);

    try {
        // Check for existing session ID
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        const session = sessionId ? sessions.get(sessionId) : undefined;
        let transport: StreamableHTTPServerTransport;

        if (session) {
            // Check if the transport is of the correct type
            if (session.transport instanceof StreamableHTTPServerTransport) {
                // Reuse existing transport
                transport = session.transport;
                trackResponse(session, res);
            } else {
                // Transport exists but is not a StreamableHTTPServerTransport (could be SSEServerTransport)
                res.status(400).json({
                    jsonrpc: '2.0',
                    error: {
                        code: -32000,
                        message: 'Bad Request: Session exists but uses a different transport protocol'
                    },
                    id: null
                });
                return;
            }
        } else if (!sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
            if (sessions.size >= MAX_SESSIONS) {
                res.status(503).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Too many open sessions' }, id: null });
                return;
            }
            const eventStore = new InMemoryEventStore();
            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                eventStore, // Enable resumability
                onsessioninitialized: sessionId => {
                    // Store the transport by session ID when session is initialized
                    console.log(`StreamableHTTP session initialized with ID: ${sessionId}`);
                    sessions.set(sessionId, { transport, open: 0, lastActive: Date.now() });
                }
            });

            // Set up onclose handler to clean up transport when closed
            transport.onclose = () => {
                const sid = transport.sessionId;
                if (sid && sessions.has(sid)) {
                    console.log(`Transport closed for session ${sid}, removing from sessions map`);
                    sessions.delete(sid);
                }
            };

            // Connect the transport to the MCP server
            const server = getServer();
            await server.connect(transport);
        } else if (sessionId) {
            // Unknown or expired session ID - the client should start a new session
            res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
            return;
        } else {
            // Invalid request - no session ID and not an initialization request
            res.status(400).json({
                jsonrpc: '2.0',
                error: {
                    code: -32000,
                    message: 'Bad Request: No valid session ID provided'
                },
                id: null
            });
            return;
        }

        // Handle the request with the transport
        await transport.handleRequest(req, res, req.body);
    } catch (error) {
        console.error('Error handling MCP request:', error);
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: '2.0',
                error: {
                    code: -32603,
                    message: 'Internal server error'
                },
                id: null
            });
        }
    }
});

//=============================================================================
// DEPRECATED HTTP+SSE TRANSPORT (PROTOCOL VERSION 2024-11-05)
//=============================================================================

app.get('/sse', async (req: Request, res: Response) => {
    console.log('Received GET request to /sse (deprecated SSE transport)');
    if (sessions.size >= MAX_SESSIONS) {
        res.status(503).send('Too many open sessions');
        return;
    }
    const transport = new SSEServerTransport('/messages', res);
    // An SSE session lasts as long as this response, which counts as open until it closes
    const session = { transport, open: 0, lastActive: Date.now() };
    sessions.set(transport.sessionId, session);
    trackResponse(session, res);
    // Set up onclose handler to clean up transport when closed
    transport.onclose = () => {
        sessions.delete(transport.sessionId);
    };
    const server = getServer();
    await server.connect(transport);
});

app.post('/messages', async (req: Request, res: Response) => {
    const sessionId = req.query.sessionId as string;
    let transport: SSEServerTransport;
    const existingTransport = sessions.get(sessionId)?.transport;
    if (existingTransport instanceof SSEServerTransport) {
        // Reuse existing transport
        transport = existingTransport;
    } else {
        // Transport exists but is not a SSEServerTransport (could be StreamableHTTPServerTransport)
        res.status(400).json({
            jsonrpc: '2.0',
            error: {
                code: -32000,
                message: 'Bad Request: Session exists but uses a different transport protocol'
            },
            id: null
        });
        return;
    }
    if (transport) {
        await transport.handlePostMessage(req, res, req.body);
    } else {
        res.status(400).send('No transport found for sessionId');
    }
});

// Start the server
const PORT = 3000;
app.listen(PORT, error => {
    if (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
    console.log(`Backwards compatible MCP server listening on port ${PORT}`);
    console.log(`
==============================================
SUPPORTED TRANSPORT OPTIONS:

1. Streamable Http(Protocol version: 2025-11-25)
   Endpoint: /mcp
   Methods: GET, POST, DELETE
   Usage:
     - Initialize with POST to /mcp
     - Establish SSE stream with GET to /mcp
     - Send requests with POST to /mcp
     - Terminate session with DELETE to /mcp

2. Http + SSE (Protocol version: 2024-11-05)
   Endpoints: /sse (GET) and /messages (POST)
   Usage:
     - Establish SSE stream with GET to /sse
     - Send requests with POST to /messages?sessionId=<id>
==============================================
`);
});

// Handle server shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down server...');

    // Close all active transports to properly clean up resources
    for (const [sessionId, { transport }] of sessions) {
        try {
            console.log(`Closing transport for session ${sessionId}`);
            await transport.close();
            sessions.delete(sessionId);
        } catch (error) {
            console.error(`Error closing transport for session ${sessionId}:`, error);
        }
    }
    console.log('Server shutdown complete');
    process.exit(0);
});
