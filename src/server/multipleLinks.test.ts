import { Client } from '../client/index.js';
import { SSEClientTransport } from '../client/sse.js';
import { StreamableHTTPClientTransport } from '../client/streamableHttp.js';
import express, { Request, Response } from 'express';
import { McpServer } from '../server/mcp.js';
import { SSEServerTransport } from '../server/sse.js';
import { InMemoryEventStore } from '../examples/shared/inMemoryEventStore.js';
import { StreamableHTTPServerTransport } from '../server/streamableHttp.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import * as http from 'http';
import cors from 'cors';
import { isInitializeRequest } from '../types.js';

const server = new McpServer(
    {
        name: 'simple-sse-server',
        version: '1.0.0'
    },
    { capabilities: { logging: {} } }
);

server.registerTool(
    'sayHello',
    {
        description: 'Says hello to the user',
        inputSchema: {
            name: z.string().describe('Name to include in greeting')
        }
    },
    async ({ name }) => {
        return {
            content: [{ type: 'text', text: 'Hello, ' + name + '!' }]
        };
    }
);

const transports: Record<string, StreamableHTTPServerTransport | SSEServerTransport> = {};

let expressServer: http.Server;

describe.only('multipleLinks.test.js', () => {
    beforeAll(async () => {
        const app = express();
        app.use(express.json());

        app.use(
            cors({
                origin: '*', // Allow all origins - adjust as needed for production
                exposedHeaders: ['Mcp-Session-Id']
            })
        );

        app.get('/sse', async (req: Request, res: Response) => {
            console.log('Received GET request to /sse (establishing SSE stream)');

            try {
                // Create a new SSE transport for the client
                // The endpoint for POST messages is '/messages'
                const transport = new SSEServerTransport('/messages', res);

                // Store the transport by session ID
                const sessionId = transport.sessionId;
                transports[sessionId] = transport;

                // Set up onclose handler to clean up transport when closed
                transport.onclose = () => {
                    delete transports[sessionId];
                };

                // Connect the transport to the MCP server
                await server.connect(transport);

                console.log(`Established SSE stream with session ID: ${sessionId}`);
            } catch (error) {
                console.error('Error establishing SSE stream:', error);
                if (!res.headersSent) {
                    res.status(500).send('Error establishing SSE stream');
                }
            }
        });

        app.post('/messages', async (req: Request, res: Response) => {
            console.log('Received POST request to /messages');

            // Extract session ID from URL query parameter
            // In the SSE protocol, this is added by the client based on the endpoint event
            const sessionId = req.query.sessionId as string | undefined;

            console.log('Session ID:', sessionId);

            if (!sessionId) {
                console.error('No session ID provided in request URL');
                res.status(400).send('Missing sessionId parameter');
                return;
            }

            const transport = transports[sessionId] as SSEServerTransport;
            if (!transport) {
                console.error(`No active transport found for session ID: ${sessionId}`);
                res.status(404).send('Session not found');
                return;
            }

            try {
                // Handle the POST message with the transport
                await transport.handlePostMessage(req, res, req.body);
            } catch (error) {
                console.error('Error handling request:', error);
                if (!res.headersSent) {
                    res.status(500).send('Error handling request');
                }
            }
        });

        app.all('/mcp', async (req: Request, res: Response) => {
            console.log(`Received ${req.method} request to /mcp`);

            try {
                // Check for existing session ID
                const sessionId = req.headers['mcp-session-id'] as string | undefined;
                let transport: StreamableHTTPServerTransport;

                if (sessionId && transports[sessionId]) {
                    // Check if the transport is of the correct type
                    const existingTransport = transports[sessionId];
                    if (existingTransport instanceof StreamableHTTPServerTransport) {
                        // Reuse existing transport
                        transport = existingTransport;
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
                    const eventStore = new InMemoryEventStore();
                    transport = new StreamableHTTPServerTransport({
                        sessionIdGenerator: () => randomUUID(),
                        eventStore, // Enable resumability
                        onsessioninitialized: sessionId => {
                            // Store the transport by session ID when session is initialized
                            console.log(`StreamableHTTP session initialized with ID: ${sessionId}`);
                            transports[sessionId] = transport;
                        }
                    });

                    // Set up onclose handler to clean up transport when closed
                    transport.onclose = () => {
                        const sid = transport.sessionId;
                        if (sid && transports[sid]) {
                            console.log(`Transport closed for session ${sid}, removing from transports map`);
                            delete transports[sid];
                        }
                    };

                    // Connect the transport to the MCP server
                    await server.connect(transport);
                } else {
                    // Invalid request - no session ID or not initialization request
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

        app.post('/stateless/mcp', async (req: Request, res: Response) => {
            try {
                const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: undefined
                });
                await server.connect(transport);
                await transport.handleRequest(req, res, req.body);
                res.on('close', () => {
                    console.log('Request closed');
                    transport.close();
                    server.close();
                });
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

        app.get('/stateless/mcp', async (req: Request, res: Response) => {
            console.log('Received GET MCP request');
            res.writeHead(405).end(
                JSON.stringify({
                    jsonrpc: '2.0',
                    error: {
                        code: -32000,
                        message: 'Method not allowed.'
                    },
                    id: null
                })
            );
        });

        app.delete('/stateless/mcp', async (req: Request, res: Response) => {
            console.log('Received DELETE MCP request');
            res.writeHead(405).end(
                JSON.stringify({
                    jsonrpc: '2.0',
                    error: {
                        code: -32000,
                        message: 'Method not allowed.'
                    },
                    id: null
                })
            );
        });

        let serverResolve: () => void;

        const serverReady = new Promise<void>(resolve => {
            serverResolve = resolve;
        });

        // Start the server
        const PORT = 3002;
        expressServer = app.listen(PORT, error => {
            if (error) {
                console.error('Failed to start server:', error);
                process.exit(1);
            }
            console.log(`Simple SSE Server (deprecated protocol version 2024-11-05) listening on port ${PORT}`);
            serverResolve();
        });
        await serverReady;
    });

    afterAll(async () => {
        console.log('Shutting down server...');

        // Close all active transports to properly clean up resources
        for (const sessionId in transports) {
            try {
                console.log(`Closing transport for session ${sessionId}`);
                await transports[sessionId].close();
                delete transports[sessionId];
            } catch (error) {
                console.error(`Error closing transport for session ${sessionId}:`, error);
            }
        }
        await server.close();
        await expressServer.close();

        console.log('Server shutdown complete');
    });

    it('should run multiple sse links', async () => {
        const firstClient = new Client({
            name: 'test-first-client',
            version: '1.0.0'
        });

        const firstTransport = new SSEClientTransport(new URL('http://localhost:3002/sse'));

        await firstClient.connect(firstTransport);

        const secondClient = new Client({
            name: 'test-second-client',
            version: '1.0.0'
        });

        const secondTransport = new SSEClientTransport(new URL('http://localhost:3002/sse'));

        await secondClient.connect(secondTransport);

        await firstClient.callTool({
            name: 'sayHello',
            arguments: {
                name: 'John'
            }
        });

        await secondClient.callTool({
            name: 'sayHello',
            arguments: {
                name: 'John'
            }
        });

        await firstClient.close();
        await secondClient.close();
    });

    it('should run multiple streamable links', async () => {
        const firstClient = new Client({
            name: 'test-first-client',
            version: '1.0.0'
        });

        const firstTransport = new StreamableHTTPClientTransport(new URL('http://localhost:3002/mcp'));

        await firstClient.connect(firstTransport);

        const secondClient = new Client({
            name: 'test-second-client',
            version: '1.0.0'
        });

        const secondTransport = new StreamableHTTPClientTransport(new URL('http://localhost:3002/mcp'));

        await secondClient.connect(secondTransport);

        await firstClient.callTool({
            name: 'sayHello',
            arguments: {
                name: 'John'
            }
        });

        await secondClient.callTool({
            name: 'sayHello',
            arguments: {
                name: 'John'
            }
        });

        await firstClient.close();
        await secondClient.close();
    });

    it('should run multiple stateless streamable links', async () => {
        const firstClient = new Client({
            name: 'test-first-client',
            version: '1.0.0'
        });

        const firstTransport = new StreamableHTTPClientTransport(new URL('http://localhost:3002/stateless/mcp'));

        await firstClient.connect(firstTransport);

        const secondClient = new Client({
            name: 'test-second-client',
            version: '1.0.0'
        });

        const secondTransport = new StreamableHTTPClientTransport(new URL('http://localhost:3002/stateless/mcp'));

        await secondClient.connect(secondTransport);

        await firstClient.callTool({
            name: 'sayHello',
            arguments: {
                name: 'John'
            }
        });

        await secondClient.callTool({
            name: 'sayHello',
            arguments: {
                name: 'John'
            }
        });

        await firstClient.close();
        await secondClient.close();
    });
});
