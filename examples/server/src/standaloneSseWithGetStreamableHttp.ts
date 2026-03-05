import { randomUUID } from 'node:crypto';

import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { ReadResourceResult } from '@modelcontextprotocol/server';
import { isInitializeRequest, McpServer } from '@modelcontextprotocol/server';
import type { Request, Response } from 'express';

// Helper to register a dynamic resource on a given server instance
const addResource = (server: McpServer, name: string, content: string) => {
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

// Create a fresh MCP server per client connection to avoid shared state between clients
const getServer = () => {
    const server = new McpServer({
        name: 'resource-list-changed-notification-server',
        version: '1.0.0'
    });

    addResource(server, 'example-resource', 'Initial content for example-resource');

    return server;
};

// Store transports and their associated servers by session ID
const transports: { [sessionId: string]: NodeStreamableHTTPServerTransport } = {};
const servers: { [sessionId: string]: McpServer } = {};

// Periodically add a new resource to all active server instances for testing
const resourceChangeInterval = setInterval(() => {
    const name = randomUUID();
    for (const sessionId in servers) {
        addResource(servers[sessionId]!, name, `Content for ${name}`);
    }
}, 5000); // Change resources every 5 seconds for testing

const app = createMcpExpressApp();

app.post('/mcp', async (req: Request, res: Response) => {
    console.log('Received MCP request:', req.body);
    try {
        // Check for existing session ID
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        let transport: NodeStreamableHTTPServerTransport;

        if (sessionId && transports[sessionId]) {
            // Reuse existing transport
            transport = transports[sessionId];
        } else if (!sessionId && isInitializeRequest(req.body)) {
            // New initialization request - create a fresh server for this client
            const server = getServer();
            transport = new NodeStreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: sessionId => {
                    // Store the transport and server by session ID when session is initialized
                    // This avoids race conditions where requests might come in before the session is stored
                    console.log(`Session initialized with ID: ${sessionId}`);
                    transports[sessionId] = transport;
                    servers[sessionId] = server;
                }
            });

            // Clean up both maps when the transport closes
            transport.onclose = () => {
                const sid = transport.sessionId;
                if (sid) {
                    delete transports[sid];
                    delete servers[sid];
                }
            };

            // Connect the fresh MCP server to the transport
            await server.connect(transport);

            // Handle the request - the onsessioninitialized callback will store the transport
            await transport.handleRequest(req, res, req.body);
            return; // Already handled
        } else {
            // Invalid request - no session ID or not initialization request
            res.status(400).json({
                jsonrpc: '2.0',
                error: {
                    code: -32_000,
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
                    code: -32_603,
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
    if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
    }

    console.log(`Establishing SSE stream for session ${sessionId}`);
    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
});

// Start the server
const PORT = 3000;
app.listen(PORT, error => {
    if (error) {
        console.error('Failed to start server:', error);
        // eslint-disable-next-line unicorn/no-process-exit
        process.exit(1);
    }
    console.log(`Server listening on port ${PORT}`);
});

// Handle server shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down server...');
    clearInterval(resourceChangeInterval);

    // Close all active transports to properly clean up resources
    for (const sessionId in transports) {
        try {
            console.log(`Closing transport for session ${sessionId}`);
            await transports[sessionId]!.close();
            delete transports[sessionId];
            delete servers[sessionId];
        } catch (error) {
            console.error(`Error closing transport for session ${sessionId}:`, error);
        }
    }
    console.log('Server shutdown complete');
    process.exit(0);
});
