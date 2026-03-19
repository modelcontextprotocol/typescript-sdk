/**
 * Remote MCP Server Example
 *
 * A minimal, runnable example of a remote MCP server using StreamableHTTP transport.
 * This demonstrates:
 *   - Session management (stateful server that tracks connected clients)
 *   - Streaming responses via SSE (server-sent events)
 *   - Tools, resources, and prompts
 *   - Proper startup and shutdown
 *
 * Run this server:
 *   pnpm --filter @modelcontextprotocol/examples-server exec tsx src/remoteServer.ts
 *
 * Then connect with the MCP Inspector, Claude Desktop, or any MCP client at:
 *   http://localhost:3000/mcp
 *
 * To connect from Claude Desktop, add this to your config:
 *   {
 *     "mcpServers": {
 *       "remote-example": {
 *         "url": "http://localhost:3000/mcp"
 *       }
 *     }
 *   }
 */

import { randomUUID } from 'node:crypto';

import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { CallToolResult, GetPromptResult, ReadResourceResult } from '@modelcontextprotocol/server';
import { isInitializeRequest, McpServer } from '@modelcontextprotocol/server';
import type { Request, Response } from 'express';
import * as z from 'zod/v4';

// -- Server factory ----------------------------------------------------------
// Each session gets its own McpServer instance. This function registers all
// the tools, resources, and prompts that clients can use.

function createServer(): McpServer {
    const server = new McpServer(
        {
            name: 'remote-mcp-server',
            version: '1.0.0'
        },
        { capabilities: { logging: {} } }
    );

    // A simple tool that returns a greeting.
    server.registerTool(
        'greet',
        {
            description: 'Returns a greeting for the given name',
            inputSchema: z.object({
                name: z.string().describe('Name to greet')
            })
        },
        async ({ name }): Promise<CallToolResult> => {
            return {
                content: [{ type: 'text', text: `Hello, ${name}! Welcome to the remote MCP server.` }]
            };
        }
    );

    // A tool that streams progress via log notifications, demonstrating how
    // long-running operations can report incremental updates to the client.
    server.registerTool(
        'count',
        {
            description: 'Counts up to a number, sending a log notification at each step',
            inputSchema: z.object({
                to: z.number().min(1).max(20).describe('Number to count up to (1-20)').default(5)
            })
        },
        async ({ to }, ctx): Promise<CallToolResult> => {
            for (let i = 1; i <= to; i++) {
                await ctx.mcpReq.log('info', `Counting: ${i} of ${to}`);
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            return {
                content: [{ type: 'text', text: `Done! Counted from 1 to ${to}.` }]
            };
        }
    );

    // A static resource.
    server.registerResource(
        'server-info',
        'info://server',
        { mimeType: 'application/json', description: 'Basic information about this server' },
        async (): Promise<ReadResourceResult> => {
            return {
                contents: [
                    {
                        uri: 'info://server',
                        text: JSON.stringify(
                            {
                                name: 'remote-mcp-server',
                                version: '1.0.0',
                                uptime: process.uptime()
                            },
                            null,
                            2
                        )
                    }
                ]
            };
        }
    );

    // A prompt template.
    server.registerPrompt(
        'summarize',
        {
            description: 'Generate a summary prompt for the given topic',
            argsSchema: z.object({
                topic: z.string().describe('Topic to summarize')
            })
        },
        async ({ topic }): Promise<GetPromptResult> => {
            return {
                messages: [
                    {
                        role: 'user',
                        content: { type: 'text', text: `Please provide a concise summary of: ${topic}` }
                    }
                ]
            };
        }
    );

    return server;
}

// -- Transport + routing -----------------------------------------------------

const app = createMcpExpressApp();

// Active sessions: maps session ID to its transport.
const sessions: Record<string, NodeStreamableHTTPServerTransport> = {};

// POST /mcp  -- the main MCP endpoint.
// The first request from a client is always an "initialize" message, which
// creates a new session. Subsequent requests include the Mcp-Session-Id header
// so the server can route them to the correct transport.
app.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
        // Case 1: Existing session -- route to its transport.
        if (sessionId && sessions[sessionId]) {
            await sessions[sessionId]!.handleRequest(req, res, req.body);
            return;
        }

        // Case 2: New client -- must be an initialize request.
        if (!sessionId && isInitializeRequest(req.body)) {
            const transport = new NodeStreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: id => {
                    sessions[id] = transport;
                    console.log(`Session created: ${id}`);
                }
            });

            transport.onclose = () => {
                const sid = transport.sessionId;
                if (sid) {
                    delete sessions[sid];
                    console.log(`Session closed: ${sid}`);
                }
            };

            const server = createServer();
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
            return;
        }

        // Case 3: Bad request -- no session and not initializing.
        res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32_000, message: 'Bad request: missing session ID or not an initialize request' },
            id: null
        });
    } catch (error) {
        console.error('Error handling POST /mcp:', error);
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: '2.0',
                error: { code: -32_603, message: 'Internal server error' },
                id: null
            });
        }
    }
});

// GET /mcp  -- opens an SSE stream for server-to-client notifications.
// The client must include the Mcp-Session-Id header from initialization.
app.get('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !sessions[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
    }
    await sessions[sessionId]!.handleRequest(req, res);
});

// DELETE /mcp  -- terminates a session.
app.delete('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !sessions[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
    }
    await sessions[sessionId]!.handleRequest(req, res);
});

// -- Start -------------------------------------------------------------------

const PORT = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 3000;

app.listen(PORT, error => {
    if (error) {
        console.error('Failed to start server:', error);
        // eslint-disable-next-line unicorn/no-process-exit
        process.exit(1);
    }
    console.log(`Remote MCP server listening at http://localhost:${PORT}/mcp`);
    console.log('Use Ctrl+C to stop.');
});

// Graceful shutdown: close all active transports.
process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    for (const [id, transport] of Object.entries(sessions)) {
        console.log(`Closing session ${id}`);
        await transport.close();
    }
    process.exit(0);
});
