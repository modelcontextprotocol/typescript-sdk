import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import express from 'express';
import {
    McpServer,
    StreamableHTTPServerTransport,
    isInitializeRequest
} from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const SESSION_TIMEOUT_MS = 5000; // 5 second session timeout for testing

const getServer = () => {
    const server = new McpServer({
        name: 'session-recovery-test-server',
        version: '1.0.0'
    });

    server.registerTool(
        'echo',
        {
            description: 'Echoes back the input message',
            inputSchema: {
                message: z.string().describe('Message to echo')
            }
        },
        async ({ message }): Promise<CallToolResult> => {
            return {
                content: [{ type: 'text', text: `Echo: ${message}` }]
            };
        }
    );

    return server;
};

const app = express();
app.use(express.json());

// Map to store transports by session ID with timestamps
const transports: { [sessionId: string]: { transport: StreamableHTTPServerTransport; lastAccess: number } } = {};

// Cleanup expired sessions periodically
setInterval(() => {
    const now = Date.now();
    for (const sessionId in transports) {
        if (now - transports[sessionId].lastAccess > SESSION_TIMEOUT_MS) {
            console.log(`[SERVER] Session ${sessionId} expired (timeout: ${SESSION_TIMEOUT_MS}ms)`);
            transports[sessionId].transport.close();
            delete transports[sessionId];
        }
    }
}, 1000); // Check every second

app.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
        if (sessionId && transports[sessionId]) {
            // Update last access time
            transports[sessionId].lastAccess = Date.now();
            console.log(`[SERVER] Request for existing session: ${sessionId}`);
            await transports[sessionId].transport.handleRequest(req, res, req.body);
            return;
        } else if (sessionId && !transports[sessionId]) {
            // Session ID provided but not found - session expired
            console.log(`[SERVER] Session not found: ${sessionId} - returning 404`);
            res.status(404).json({
                jsonrpc: '2.0',
                error: {
                    code: -32000,
                    message: 'Session not found'
                },
                id: null
            });
            return;
        } else if (!sessionId && isInitializeRequest(req.body)) {
            // New initialization request
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (newSessionId) => {
                    console.log(`[SERVER] New session initialized: ${newSessionId}`);
                    transports[newSessionId] = { transport, lastAccess: Date.now() };
                }
            });

            transport.onclose = () => {
                const sid = transport.sessionId;
                if (sid && transports[sid]) {
                    console.log(`[SERVER] Transport closed for session ${sid}`);
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
                error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
                id: null
            });
            return;
        }
    } catch (error) {
        console.error('[SERVER] Error:', error);
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: '2.0',
                error: { code: -32603, message: 'Internal server error' },
                id: null
            });
        }
    }
});

app.get('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
        res.status(404).send('Session not found');
        return;
    }
    transports[sessionId].lastAccess = Date.now();
    await transports[sessionId].transport.handleRequest(req, res);
});

app.delete('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
        res.status(404).send('Session not found');
        return;
    }
    await transports[sessionId].transport.handleRequest(req, res);
});

const PORT = 3456;
app.listen(PORT, () => {
    console.log(`[SERVER] Session recovery test server running on port ${PORT}`);
    console.log(`[SERVER] Session timeout: ${SESSION_TIMEOUT_MS}ms`);
    console.log(`[SERVER] Sessions will expire after ${SESSION_TIMEOUT_MS / 1000} seconds of inactivity`);
});
