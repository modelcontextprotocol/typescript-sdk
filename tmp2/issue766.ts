import express from 'express';
import { z } from 'zod';
import cors from 'cors';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isInitializeRequest, SetLevelRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';

const LogLevelMap = {
    emergency: 0,
    alert: 1,
    critical: 2,
    error: 3,
    warning: 4,
    notice: 5,
    info: 6,
    debug: 7,
}
const validLogLevels = Object.keys(LogLevelMap);

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// Store transports by session ID to send notifications
const transports = {};

const getServer = () => {
    // Create an MCP server with implementation details
    const server = new McpServer({
        name: 'stateless-streamable-http-server',
        version: '1.0.0',
    }, { capabilities: { logging: {} } });

    server.tool(
        "sum",
        { a: z.number(), b: z.number() },
        async ({ a, b }) => {
            server.server.sendLoggingMessage({ level: "debug", data: { message: "Received input", a, b } });
            await sleep(1000);
            const result = a + b;
            server.server.sendLoggingMessage({ level: "info", data: { message: "Sum calculated", result } });
            return {
                content: [{ type: "text", text: "Result: " + result }],
            };
        }
    );
    server.server.setRequestHandler(
        SetLevelRequestSchema,
        async (request) => {
            const levelName = request.params.level;
            if (validLogLevels.includes(levelName)) {
                server.server.sendLoggingMessage({ level: "debug", data: { message: "Set root log level to " + levelName } });
            } else {
                server.server.sendLoggingMessage({ level: "warning", data: { message: "Invalid log level " + levelName + " received" } });
            }
            return {};
        }
    );

    return server;
}

const app = express();
app.use(express.json());

// Configure CORS to expose Mcp-Session-Id header for browser-based clients
app.use(cors({
    origin: '*', // Allow all origins - adjust as needed for production
    exposedHeaders: ['Mcp-Session-Id'],
}));

const server = getServer();
app.post('/mcp', async (req, res) => {
    console.log('Received MCP POST request:', req.body);
    try {
        // Check for existing session ID
        const sessionId = req.headers['mcp-session-id'];
        let transport;

        if (sessionId && transports[sessionId]) {
            // Reuse existing transport
            transport = transports[sessionId];
        } else if (!sessionId && isInitializeRequest(req.body)) {
            // New initialization request
            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (sessionId) => {
                    // Store the transport by session ID when session is initialized
                    // This avoids race conditions where requests might come in before the session is stored
                    console.log("Session initialized with ID: ", sessionId);
                    transports[sessionId] = transport;
                }
            });

            // Connect the transport to the MCP server
            await server.connect(transport);

            // Handle the request - the onsessioninitialized callback will store the transport
            await transport.handleRequest(req, res, req.body);
            return; // Already handled
        } else {
            // Invalid request - no session ID or not initialization request
            res.status(400).json({
                jsonrpc: '2.0',
                error: {
                    code: -32000,
                    message: 'Bad Request: No valid session ID provided',
                },
                id: null,
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
                    message: 'Internal server error',
                },
                id: null,
            });
        }
    }
});

// Handle GET requests for SSE streams (now using built-in support from StreamableHTTP)
app.get('/mcp', async (req, res) => {
    console.log('Received MCP GET request:', req);
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
    }

    console.log("Establishing SSE stream for session", sessionId);
    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
});

// Start the server
const PORT = 3000;
app.listen(PORT, (error) => {
    if (error) {
        console.error('Failed to start server:', error);
        process.exit(1);
    }
    console.log("MCP Streamable HTTP Server listening on port", PORT);
});

// Handle server shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down server...');
    process.exit(0);
});

/*
Refs:

https://www.mcpevals.io/blog/mcp-logging-tutorial
https://github.com/modelcontextprotocol/typescript-sdk/blob/main/src/examples/server/standaloneSseWithGetStreamableHttp.ts

*/`