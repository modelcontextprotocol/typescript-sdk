/**
 * Example MCP Server using Express with FetchStreamableHTTPServerTransport
 *
 * This example demonstrates how to use the experimental FetchStreamableHTTPServerTransport
 * with Express by converting between Node.js HTTP and Web Standard Request/Response.
 *
 * The FetchStreamableHTTPServerTransport uses Web Standard APIs, so we need adapter
 * functions to convert Express's req/res to Web Standard Request/Response.
 *
 * To run this example:
 *   npx tsx src/examples/server/expressFetchStreamableHttp.ts
 *
 * Then test with curl:
 *   # Initialize
 *   curl -X POST http://localhost:3000/mcp \
 *     -H "Content-Type: application/json" \
 *     -H "Accept: application/json, text/event-stream" \
 *     -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","clientInfo":{"name":"test","version":"1.0"},"capabilities":{}},"id":1}'
 */

import express from 'express';
import cors from 'cors';
import { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '../../server/mcp.js';
import { FetchStreamableHTTPServerTransport } from '../../experimental/fetch-streamable-http/index.js';
import { CallToolResult, GetPromptResult, ReadResourceResult } from '../../types.js';
import { z } from 'zod';

// Create the Express app
const app = express();

// Store active transports by session ID for session management
const transports = new Map<string, FetchStreamableHTTPServerTransport>();

/**
 * Converts a Node.js IncomingMessage to a Web Standard Request
 */
async function nodeRequestToWebRequest(req: IncomingMessage, baseUrl: string): Promise<Request> {
    const url = new URL(req.url ?? '/', baseUrl);
    const headers = new Headers();

    for (const [key, value] of Object.entries(req.headers)) {
        if (value) {
            if (Array.isArray(value)) {
                value.forEach(v => headers.append(key, v));
            } else {
                headers.set(key, value);
            }
        }
    }

    // For requests with body (POST), we need to read the body
    let body: string | null = null;
    if (req.method === 'POST') {
        body = await new Promise<string>((resolve, reject) => {
            let data = '';
            req.on('data', chunk => {
                data += chunk;
            });
            req.on('end', () => resolve(data));
            req.on('error', reject);
        });
    }

    return new Request(url.toString(), {
        method: req.method,
        headers,
        body: body,
        // @ts-expect-error duplex is required for streams but not in types
        duplex: 'half'
    });
}

/**
 * Converts a Web Standard Response to a Node.js ServerResponse
 */
async function webResponseToNodeResponse(webResponse: Response, res: ServerResponse): Promise<void> {
    // Set status code
    res.statusCode = webResponse.status;

    // Copy headers
    webResponse.headers.forEach((value, key) => {
        res.setHeader(key, value);
    });

    // Handle streaming response (SSE)
    if (webResponse.body) {
        const reader = webResponse.body.getReader();
        const decoder = new TextDecoder();

        // For SSE, we need to flush headers immediately
        if (webResponse.headers.get('content-type') === 'text/event-stream') {
            res.flushHeaders();
        }

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                res.write(chunk);

                // Flush for SSE to ensure real-time delivery
                if (typeof (res as NodeJS.WritableStream & { flush?: () => void }).flush === 'function') {
                    (res as NodeJS.WritableStream & { flush?: () => void }).flush!();
                }
            }
        } catch {
            // Client disconnected or stream error
        } finally {
            res.end();
        }
    } else {
        res.end();
    }
}

/**
 * Creates and configures an MCP server with example tools, resources, and prompts
 */
function createMcpServer(): McpServer {
    const server = new McpServer(
        {
            name: 'express-fetch-streamable-http-server',
            version: '1.0.0'
        },
        { capabilities: { logging: {} } }
    );

    // Register a simple tool
    server.registerTool(
        'greet',
        {
            description: 'Greets someone by name',
            inputSchema: {
                name: z.string().describe('The name to greet')
            }
        },
        async ({ name }): Promise<CallToolResult> => {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Hello, ${name}! Welcome to the Express MCP server.`
                    }
                ]
            };
        }
    );

    // Register a calculator tool
    server.registerTool(
        'calculate',
        {
            description: 'Performs a simple calculation',
            inputSchema: {
                operation: z.enum(['add', 'subtract', 'multiply', 'divide']).describe('The operation to perform'),
                a: z.number().describe('First operand'),
                b: z.number().describe('Second operand')
            }
        },
        async ({ operation, a, b }): Promise<CallToolResult> => {
            let result: number;
            switch (operation) {
                case 'add':
                    result = a + b;
                    break;
                case 'subtract':
                    result = a - b;
                    break;
                case 'multiply':
                    result = a * b;
                    break;
                case 'divide':
                    if (b === 0) {
                        return {
                            content: [{ type: 'text', text: 'Error: Division by zero' }],
                            isError: true
                        };
                    }
                    result = a / b;
                    break;
            }
            return {
                content: [
                    {
                        type: 'text',
                        text: `${a} ${operation} ${b} = ${result}`
                    }
                ]
            };
        }
    );

    // Register a prompt
    server.registerPrompt(
        'code-review',
        {
            description: 'A prompt template for code review',
            argsSchema: {
                language: z.string().describe('Programming language'),
                code: z.string().describe('Code to review')
            }
        },
        async ({ language, code }): Promise<GetPromptResult> => {
            return {
                messages: [
                    {
                        role: 'user',
                        content: {
                            type: 'text',
                            text: `Please review the following ${language} code:\n\n\`\`\`${language}\n${code}\n\`\`\``
                        }
                    }
                ]
            };
        }
    );

    // Register a resource
    server.registerResource(
        'server-info',
        'mcp://server/info',
        {
            description: 'Information about this MCP server',
            mimeType: 'application/json'
        },
        async (): Promise<ReadResourceResult> => {
            return {
                contents: [
                    {
                        uri: 'mcp://server/info',
                        mimeType: 'application/json',
                        text: JSON.stringify(
                            {
                                name: 'express-fetch-streamable-http-server',
                                version: '1.0.0',
                                runtime: 'Node.js',
                                framework: 'Express',
                                transport: 'FetchStreamableHTTPServerTransport',
                                timestamp: new Date().toISOString()
                            },
                            null,
                            2
                        )
                    }
                ]
            };
        }
    );

    return server;
}

// Configure CORS middleware
app.use(
    cors({
        origin: '*',
        methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Accept', 'mcp-session-id', 'last-event-id', 'mcp-protocol-version'],
        exposedHeaders: ['mcp-session-id']
    })
);

// MCP endpoint - handles all methods
app.all('/mcp', async (req, res) => {
    const baseUrl = `http://${req.headers.host}`;

    // Check for existing session
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
        // Reuse existing transport for this session
        const transport = transports.get(sessionId)!;
        const webRequest = await nodeRequestToWebRequest(req, baseUrl);
        const webResponse = await transport.handleRequest(webRequest);
        await webResponseToNodeResponse(webResponse, res);
        return;
    }

    // For new sessions or initialization, create new transport and server
    const server = createMcpServer();
    const transport = new FetchStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: sessionId => {
            // Store the transport for session reuse
            transports.set(sessionId, transport);
            console.log(`Session initialized: ${sessionId}`);
        },
        onsessionclosed: sessionId => {
            // Clean up when session closes
            transports.delete(sessionId);
            console.log(`Session closed: ${sessionId}`);
        }
    });

    await server.connect(transport);

    const webRequest = await nodeRequestToWebRequest(req, baseUrl);
    const webResponse = await transport.handleRequest(webRequest);
    await webResponseToNodeResponse(webResponse, res);
});

// Health check endpoint
app.get('/health', (_req, res) => {
    res.json({
        status: 'healthy',
        activeSessions: transports.size,
        timestamp: new Date().toISOString()
    });
});

// Start the server
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`MCP server running at http://localhost:${PORT}/mcp`);
});

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log('\nShutting down server...');

    // Close all active transports
    for (const [sessionId, transport] of transports) {
        console.log(`Closing session: ${sessionId}`);
        await transport.close();
    }
    transports.clear();

    console.log('Server stopped.');
    process.exit(0);
});
