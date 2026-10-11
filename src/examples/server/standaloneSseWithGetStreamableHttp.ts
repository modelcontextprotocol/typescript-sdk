import { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '../../server/mcp.js';
import { StreamableHTTPServerTransport } from '../../server/streamableHttp.js';
import { isInitializeRequest, ReadResourceResult } from '../../types.js';
import { createMcpExpressApp } from '../../server/express.js';

// Factory to create a new MCP server per session.
// Each session needs its own server+transport pair to avoid cross-session contamination.
const getServer = () => {
    const server = new McpServer({
        name: 'resource-list-changed-notification-server',
        version: '1.0.0'
    });

    const addResource = (name: string, content: string) => {
        const uri = `https://mcp-example.com/dynamic/${encodeURIComponent(name)}`;
        server.registerResource(
            name,
            uri,
            { mimeType: 'text/plain', description: `Dynamic resource: ${name}` },
            async (): Promise<ReadResourceResult> => {
                return {
                    contents: [{ uri, text: content }]
                };
            }
        );
    };

    addResource('example-resource', 'Initial content for example-resource');

    // Periodically add new resources to demonstrate notifications
    const resourceChangeInterval = setInterval(() => {
        const name = randomUUID();
        addResource(name, `Content for ${name}`);
    }, 5000);

    // Clean up the interval when the server closes
    server.server.onclose = () => {
        clearInterval(resourceChangeInterval);
    };

    return server;
};

// Close sessions that have been idle for IDLE_MS, and keep at most MAX_SESSIONS open
const IDLE_MS = 30 * 60_000;
const MAX_SESSIONS = 1000;

// Store sessions by session ID to send notifications
type Session = { transport: StreamableHTTPServerTransport; open: number; lastActive: number };
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
        if (open === 0 && lastActive < cutoff) transport.close().catch(console.error);
    }
}, 60_000).unref();

const app = createMcpExpressApp();

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
            // New initialization request
            if (sessions.size >= MAX_SESSIONS) {
                res.status(503).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Too many open sessions' }, id: null });
                return;
            }
            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
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

            // Create a new server per session and connect it to the transport
            const server = getServer();
            await server.connect(transport);

            // Handle the request - the onsessioninitialized callback will store the transport
            await transport.handleRequest(req, res, req.body);
            // If the transport rejected the request no session was created, so close it to stop the server's interval
            if (!transport.sessionId) await transport.close();
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

        // Handle the request with existing transport
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

// Handle GET requests for SSE streams (now using built-in support from StreamableHTTP)
app.get('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId) {
        res.status(400).send('Missing session ID');
        return;
    }
    const session = sessions.get(sessionId);
    if (!session) {
        // Unknown or expired session ID - the client should start a new session
        res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
        return;
    }

    console.log(`Establishing SSE stream for session ${sessionId}`);
    trackResponse(session, res);
    await session.transport.handleRequest(req, res);
});

// Start the server
const PORT = 3000;
app.listen(PORT, error => {
    if (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
    console.log(`Server listening on port ${PORT}`);
});

// Handle server shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down server...');
    for (const [sessionId, { transport }] of sessions) {
        await transport.close();
        sessions.delete(sessionId);
    }
    process.exit(0);
});
