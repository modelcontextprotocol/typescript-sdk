import { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '../../server/mcp.js';
import { StreamableHTTPServerTransport } from '../../server/streamableHttp.js';
import * as z from 'zod/v4';
import { CallToolResult, isInitializeRequest } from '../../types.js';
import { createMcpExpressApp } from '../../server/express.js';

// Create an MCP server with implementation details
const getServer = () => {
    const server = new McpServer(
        {
            name: 'json-response-streamable-http-server',
            version: '1.0.0'
        },
        {
            capabilities: {
                logging: {}
            }
        }
    );

    // Register a simple tool that returns a greeting
    server.registerTool(
        'greet',
        {
            description: 'A simple greeting tool',
            inputSchema: {
                name: z.string().describe('Name to greet')
            }
        },
        async ({ name }): Promise<CallToolResult> => {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Hello, ${name}!`
                    }
                ]
            };
        }
    );

    // Register a tool that sends multiple greetings with notifications
    server.registerTool(
        'multi-greet',
        {
            description: 'A tool that sends different greetings with delays between them',
            inputSchema: {
                name: z.string().describe('Name to greet')
            }
        },
        async ({ name }, extra): Promise<CallToolResult> => {
            const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

            await server.sendLoggingMessage(
                {
                    level: 'debug',
                    data: `Starting multi-greet for ${name}`
                },
                extra.sessionId
            );

            await sleep(1000); // Wait 1 second before first greeting

            await server.sendLoggingMessage(
                {
                    level: 'info',
                    data: `Sending first greeting to ${name}`
                },
                extra.sessionId
            );

            await sleep(1000); // Wait another second before second greeting

            await server.sendLoggingMessage(
                {
                    level: 'info',
                    data: `Sending second greeting to ${name}`
                },
                extra.sessionId
            );

            return {
                content: [
                    {
                        type: 'text',
                        text: `Good morning, ${name}!`
                    }
                ]
            };
        }
    );
    return server;
};

const app = createMcpExpressApp();

// Close sessions that have been idle for IDLE_MS, and keep at most MAX_SESSIONS open
const IDLE_MS = 30 * 60_000;
const MAX_SESSIONS = 1000;

// Map to store sessions by session ID
type Session = { transport: StreamableHTTPServerTransport; open: number; lastActive: number };
const sessions = new Map<string, Session>();

// Count open responses so a long-running request is not treated as idle
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
        if (open === 0 && lastActive < cutoff) transport.close().catch(console.error);
    }
}, 60_000).unref();

app.post('/mcp', async (req: Request, res: Response) => {
    console.log('Received MCP request:', req.body);
    try {
        // Check for existing session ID
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        const session = sessionId ? sessions.get(sessionId) : undefined;
        let transport: StreamableHTTPServerTransport;

        if (session) {
            // Reuse existing transport
            transport = session.transport;
            trackResponse(session, res);
        } else if (!sessionId && isInitializeRequest(req.body)) {
            // New initialization request - use JSON response mode
            if (sessions.size >= MAX_SESSIONS) {
                res.status(503).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Too many open sessions' }, id: null });
                return;
            }
            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                enableJsonResponse: true, // Enable JSON response mode
                onsessioninitialized: sessionId => {
                    // Store the transport by session ID when session is initialized
                    // This avoids race conditions where requests might come in before the session is stored
                    console.log(`Session initialized with ID: ${sessionId}`);
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

            // Connect the transport to the MCP server BEFORE handling the request
            const server = getServer();
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
            return; // Already handled
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

        // Handle the request with existing transport - no need to reconnect
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

// Handle GET requests for SSE streams according to spec
app.get('/mcp', async (req: Request, res: Response) => {
    // Since this is a very simple example, we don't support GET requests for this server
    // The spec requires returning 405 Method Not Allowed in this case
    res.status(405).set('Allow', 'POST').send('Method Not Allowed');
});

// Start the server
const PORT = 3000;
app.listen(PORT, error => {
    if (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
    console.log(`MCP Streamable HTTP Server listening on port ${PORT}`);
});

// Handle server shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down server...');
    process.exit(0);
});
