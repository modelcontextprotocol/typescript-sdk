/**
 * Example MCP Server using Hono.js with FetchStreamableHTTPServerTransport
 *
 * This example demonstrates how to use the experimental FetchStreamableHTTPServerTransport
 * with Hono.js to create an MCP server that uses Web Standard APIs.
 *
 * The FetchStreamableHTTPServerTransport uses Web Standard Request/Response objects,
 * making it compatible with various runtimes like Cloudflare Workers, Deno, Bun, etc.
 * This example runs on Node.js using @hono/node-server.
 *
 * To run this example:
 *   npx tsx src/examples/server/honoFetchStreamableHttp.ts
 *
 * Then test with curl:
 *   # Initialize
 *   curl -X POST http://localhost:3000/mcp \
 *     -H "Content-Type: application/json" \
 *     -H "Accept: application/json, text/event-stream" \
 *     -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","clientInfo":{"name":"test","version":"1.0"},"capabilities":{}},"id":1}'
 *
 *   # List tools (use session ID from init response)
 *   curl -X POST http://localhost:3000/mcp \
 *     -H "Content-Type: application/json" \
 *     -H "Accept: application/json, text/event-stream" \
 *     -H "mcp-session-id: <session-id>" \
 *     -d '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":2}'
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { McpServer } from '../../server/mcp.js';
import { FetchStreamableHTTPServerTransport } from '../../experimental/fetch-streamable-http/index.js';
import { CallToolResult, GetPromptResult, ReadResourceResult } from '../../types.js';
import { z } from 'zod';

// Create the Hono app
const app = new Hono();

// Store active transports by session ID for session management
const transports = new Map<string, FetchStreamableHTTPServerTransport>();

/**
 * Creates and configures an MCP server with example tools, resources, and prompts
 */
function createMcpServer(): McpServer {
    const server = new McpServer(
        {
            name: 'hono-fetch-streamable-http-server',
            version: '1.0.0'
        },
        { capabilities: { logging: {} } }
    );

    // Register a simple tool using the new registerTool API
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
                        text: `Hello, ${name}! Welcome to the Hono MCP server.`
                    }
                ]
            };
        }
    );

    // Register a tool that demonstrates async operations
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

    // Register a tool that sends notifications (demonstrates SSE streaming)
    server.registerTool(
        'send-notifications',
        {
            description: 'Sends a series of notifications to demonstrate SSE streaming',
            inputSchema: {
                count: z.number().min(1).max(10).default(3).describe('Number of notifications to send'),
                interval: z.number().min(100).max(2000).default(500).describe('Interval between notifications in ms')
            }
        },
        async ({ count, interval }, extra): Promise<CallToolResult> => {
            const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

            for (let i = 1; i <= count; i++) {
                await server.sendLoggingMessage(
                    {
                        level: 'info',
                        data: `Notification ${i} of ${count} at ${new Date().toISOString()}`
                    },
                    extra.sessionId
                );
                if (i < count) {
                    await sleep(interval);
                }
            }

            return {
                content: [
                    {
                        type: 'text',
                        text: `Sent ${count} notifications with ${interval}ms interval`
                    }
                ]
            };
        }
    );

    // Register a simple prompt using the new registerPrompt API
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
                            text: `Please review the following ${language} code and provide feedback on:
1. Code quality and best practices
2. Potential bugs or issues
3. Performance considerations
4. Suggestions for improvement

Code:
\`\`\`${language}
${code}
\`\`\``
                        }
                    }
                ]
            };
        }
    );

    // Register a simple resource using the new registerResource API
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
                                name: 'hono-fetch-streamable-http-server',
                                version: '1.0.0',
                                runtime: 'Node.js',
                                framework: 'Hono',
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

// Configure CORS middleware for all routes
app.use(
    '*',
    cors({
        origin: '*',
        allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Accept', 'mcp-session-id', 'last-event-id', 'mcp-protocol-version'],
        exposeHeaders: ['mcp-session-id']
    })
);

// Example auth middleware (uncomment to enable authentication):
// app.use('/mcp', async (c, next) => {
//     const token = c.req.header('Authorization')?.replace('Bearer ', '');
//     if (token) {
//         // Validate token and set auth info in context
//         c.set('auth', { token, clientId: 'example-client' });
//     }
//     await next();
// });

app.all('/mcp', async c => {
    // Check for existing session
    const sessionId = c.req.header('mcp-session-id');

    if (sessionId && transports.has(sessionId)) {
        // Reuse existing transport for this session
        const transport = transports.get(sessionId)!;
        // Pass auth from context if using auth middleware: { auth: c.get('auth') }
        return transport.handleRequest(c.req.raw);
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

    // Pass auth from context if using auth middleware: { auth: c.get('auth') }
    return transport.handleRequest(c.req.raw);
});

// Health check endpoint
app.get('/health', c => {
    return c.json({
        status: 'healthy',
        activeSessions: transports.size,
        timestamp: new Date().toISOString()
    });
});

// Start the server
const PORT = 3000;
console.log(`MCP server running at http://localhost:${PORT}/mcp`);

serve({
    fetch: app.fetch,
    port: PORT
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
