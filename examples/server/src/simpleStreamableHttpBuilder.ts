/**
 * Simple Streamable HTTP Server Example using Builder Pattern
 *
 * This example demonstrates using the McpServer.builder() fluent API
 * to create and configure an MCP server with:
 * - Tools, resources, and prompts registration
 * - Middleware (logging, custom metrics)
 * - Per-tool middleware (authorization)
 * - Error handlers (onError, onProtocolError)
 * - Context helpers (logging, notifications)
 *
 * Run with: npx tsx src/simpleStreamableHttpBuilder.ts
 */

import { randomUUID } from 'node:crypto';

import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { CallToolResult, GetPromptResult, ReadResourceResult, ToolMiddleware } from '@modelcontextprotocol/server';
import { createLoggingMiddleware, isInitializeRequest, McpServer, text } from '@modelcontextprotocol/server';
import type { Request, Response } from 'express';
import * as z from 'zod/v4';

import { InMemoryEventStore } from './inMemoryEventStore.js';

// ═══════════════════════════════════════════════════════════════════════════
// Custom Middleware Examples
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Custom metrics middleware that tracks tool execution time.
 * Demonstrates how to create custom middleware.
 */
const metricsMiddleware: ToolMiddleware = async (ctx, next) => {
    const start = performance.now();
    try {
        const result = await next();
        const duration = (performance.now() - start).toFixed(2);
        console.log(`[METRICS] Tool '${ctx.name}' completed in ${duration}ms`);
        return result;
    } catch (error) {
        const duration = (performance.now() - start).toFixed(2);
        console.log(`[METRICS] Tool '${ctx.name}' failed in ${duration}ms`);
        throw error;
    }
};

/**
 * Per-tool authorization middleware example.
 * This is passed directly to a specific tool registration.
 */
const adminAuthMiddleware: ToolMiddleware = async (ctx, next) => {
    // In a real app, check ctx.authInfo for admin scope
    // For demo purposes, we'll check for a special argument
    const args = ctx.args as Record<string, unknown>;
    if (args.requiresAdmin && !args.adminToken) {
        throw new Error('Admin authorization required. Provide adminToken argument.');
    }
    console.log(`[AUTH] Admin action authorized for tool '${ctx.name}'`);
    return next();
};

// ═══════════════════════════════════════════════════════════════════════════
// Session Management
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Session data type - stores transport for each session.
 */
interface SessionData {
    transport: NodeStreamableHTTPServerTransport;
    createdAt: Date;
}

/**
 * Simple Map-based session storage.
 */
const sessions = new Map<string, SessionData>();

// ═══════════════════════════════════════════════════════════════════════════
// Server Factory
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Creates an MCP server using the builder pattern.
 *
 * The builder provides a fluent API for configuring the server:
 * - .name() and .version() set server info
 * - .options() configures capabilities
 * - .useMiddleware() adds universal middleware
 * - .useToolMiddleware() adds tool-specific middleware
 * - .tool() registers tools inline (with optional per-tool middleware)
 * - .resource() registers resources inline
 * - .prompt() registers prompts inline
 * - .onError() handles application errors
 * - .onProtocolError() handles protocol errors
 * - .build() creates the configured McpServer instance
 */
const getServer = () => {
    const server = McpServer.builder()
        .name('builder-example-server')
        .version('1.0.0')
        .options({
            capabilities: { logging: {} }
        })

        // ─── Universal Middleware ───
        // Runs for all request types (tools, resources, prompts)
        .useMiddleware(
            createLoggingMiddleware({
                level: 'info',
                logger: (level, message, data) => {
                    const timestamp = new Date().toISOString();
                    console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`, data ? JSON.stringify(data) : '');
                }
            })
        )

        // ─── Tool-Specific Middleware ───
        .useToolMiddleware(async (ctx, next) => {
            console.log(`Tool '${ctx.name}' called`);
            return next();
        })

        // Custom metrics middleware
        .useToolMiddleware(metricsMiddleware)

        // ─── Error Handlers ───
        .onError((error, ctx) => {
            console.error(`[APP ERROR] ${ctx.type}/${ctx.name || ctx.method}: ${error.message}`);
            // Return custom error response with additional context
            return {
                code: -32_000,
                message: `Error in ${ctx.name || ctx.method}: ${error.message}`,
                data: { type: ctx.type, requestId: ctx.requestId }
            };
        })
        .onProtocolError((error, ctx) => {
            console.error(`[PROTOCOL ERROR] ${ctx.method}: ${error.message}`);
            // Protocol errors preserve error code, can customize message/data
            return {
                message: `Protocol error: ${error.message}`,
                data: { requestId: ctx.requestId }
            };
        })

        // ─── Tool Registrations ───

        // Simple greeting tool
        .tool(
            'greet',
            {
                title: 'Greeting Tool',
                description: 'A simple greeting tool that returns a personalized greeting',
                inputSchema: {
                    name: z.string().describe('Name to greet')
                }
            },
            async ({ name }): Promise<CallToolResult> => {
                return {
                    content: [text(`Hello, ${name}!`)]
                };
            }
        )

        // Tool with notifications demonstrating context usage
        .tool(
            'multi-greet',
            {
                title: 'Multiple Greeting Tool',
                description: 'A tool that sends different greetings with delays and notifications',
                inputSchema: {
                    name: z.string().describe('Name to greet')
                }
            },
            async function ({ name }, ctx): Promise<CallToolResult> {
                const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

                // Use context logging helper
                await ctx.loggingNotification.debug(`Starting multi-greet for ${name}`);

                await sleep(1000);

                // Use sendNotification directly
                await ctx.sendNotification({
                    method: 'notifications/message',
                    params: {
                        level: 'info',
                        data: `Sending first greeting to ${name}`
                    }
                });

                await sleep(1000);

                await ctx.loggingNotification.info(`Sending second greeting to ${name}`);

                return {
                    content: [text(`Good morning, ${name}!`)]
                };
            }
        )

        // Context demo tool - shows all context features
        .tool(
            'context-demo',
            {
                title: 'Context Demo',
                description: 'Demonstrates all context helper methods and properties',
                inputSchema: {
                    message: z.string().describe('A message to echo back')
                }
            },
            async ({ message }, ctx): Promise<CallToolResult> => {
                // Access MCP context
                const mcpInfo = {
                    requestId: ctx.mcpCtx.requestId,
                    sessionId: ctx.mcpCtx.sessionId,
                    method: ctx.mcpCtx.method
                };

                // Access request context
                const requestInfo = {
                    signalAborted: ctx.requestCtx.signal.aborted,
                    hasAuthInfo: !!ctx.requestCtx.authInfo
                };

                // Use logging helpers at different levels
                await ctx.loggingNotification.debug('Debug: Processing context-demo');
                await ctx.loggingNotification.info('Info: Context inspection complete');

                // Send custom notification
                await ctx.sendNotification({
                    method: 'notifications/message',
                    params: {
                        level: 'debug',
                        data: `Echo: ${message}`
                    }
                });

                return {
                    content: [
                        text('Context Demo Results:'),
                        text(`MCP Context: ${JSON.stringify(mcpInfo, null, 2)}`),
                        text(`Request Context: ${JSON.stringify(requestInfo, null, 2)}`),
                        text(`Your message: ${message}`)
                    ]
                };
            }
        )

        // Tool with per-tool middleware (authorization)
        .tool(
            'admin-action',
            {
                title: 'Admin Action',
                description: 'An admin-only tool demonstrating per-tool middleware',
                inputSchema: {
                    action: z.string().describe('Admin action to perform'),
                    requiresAdmin: z.boolean().optional().describe('Whether this action requires admin auth'),
                    adminToken: z.string().optional().describe('Admin token for authorization')
                },
                middleware: adminAuthMiddleware // Per-tool middleware
            },
            async ({ action }): Promise<CallToolResult> => {
                return {
                    content: [text(`Admin action '${action}' executed successfully`)]
                };
            }
        )

        // Tool that intentionally throws an error (for testing error handlers)
        .tool(
            'error-test',
            {
                title: 'Error Test',
                description: 'A tool that throws errors to test error handlers',
                inputSchema: {
                    errorType: z.enum(['application', 'validation']).describe('Type of error to throw')
                }
            },
            async ({ errorType }): Promise<CallToolResult> => {
                const error =
                    errorType === 'application'
                        ? new Error('This is a test application error')
                        : new Error('Validation failed: invalid input format');
                throw error;
            }
        )

        // ─── Resource Registration ───
        .resource(
            'greeting-resource',
            'https://example.com/greetings/default',
            {
                title: 'Default Greeting',
                description: 'A simple greeting resource'
            },
            async (): Promise<ReadResourceResult> => {
                return {
                    contents: [
                        {
                            uri: 'https://example.com/greetings/default',
                            mimeType: 'text/plain',
                            text: 'Hello, world!'
                        }
                    ]
                };
            }
        )

        // Resource demonstrating server info
        .resource(
            'server-info',
            'https://example.com/server/info',
            {
                title: 'Server Information',
                description: 'Returns current server statistics'
            },
            async (): Promise<ReadResourceResult> => {
                const stats = {
                    activeSessions: sessions.size,
                    uptime: process.uptime()
                };
                return {
                    contents: [
                        {
                            uri: 'https://example.com/server/info',
                            mimeType: 'application/json',
                            text: JSON.stringify(stats, null, 2)
                        }
                    ]
                };
            }
        )

        // ─── Prompt Registration ───
        .prompt(
            'greeting-template',
            {
                title: 'Greeting Template',
                description: 'A simple greeting prompt template',
                argsSchema: {
                    name: z.string().describe('Name to include in greeting')
                }
            },
            async ({ name }): Promise<GetPromptResult> => {
                return {
                    messages: [
                        {
                            role: 'user',
                            content: text(`Please greet ${name} in a friendly manner.`)
                        }
                    ]
                };
            }
        )

        .build();

    return server;
};

// ═══════════════════════════════════════════════════════════════════════════
// Express App Setup
// ═══════════════════════════════════════════════════════════════════════════

const PORT = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 3000;

const app = createMcpExpressApp();

// ═══════════════════════════════════════════════════════════════════════════
// MCP Request Handlers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * MCP POST endpoint handler.
 * Uses a simple Map for session management.
 */
const mcpPostHandler = async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
        // Check for existing session
        const session = sessionId ? sessions.get(sessionId) : undefined;

        if (session) {
            // Reuse existing transport
            console.log(`[REQUEST] Using existing session: ${sessionId}`);
            await session.transport.handleRequest(req, res, req.body);
            return;
        }

        if (!sessionId && isInitializeRequest(req.body)) {
            // New initialization request - create session
            console.log('[REQUEST] New initialization request');

            const eventStore = new InMemoryEventStore();
            const transport = new NodeStreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                eventStore,
                onsessioninitialized: sid => {
                    // Store session
                    sessions.set(sid, {
                        transport,
                        createdAt: new Date()
                    });
                }
            });

            // Clean up session when transport closes
            transport.onclose = () => {
                const sid = transport.sessionId;
                if (sid) {
                    sessions.delete(sid);
                }
            };

            // Connect the transport to the MCP server
            const server = getServer();
            await server.connect(transport);

            await transport.handleRequest(req, res, req.body);
            return;
        }

        // Invalid request
        res.status(400).json({
            jsonrpc: '2.0',
            error: {
                code: -32_000,
                message: 'Bad Request: No valid session ID provided'
            },
            id: null
        });
    } catch (error) {
        console.error('[ERROR] Handling MCP request:', error);
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
};

app.post('/mcp', mcpPostHandler);

/**
 * MCP GET endpoint handler for SSE streams.
 */
const mcpGetHandler = async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const session = sessionId ? sessions.get(sessionId) : undefined;

    if (!session) {
        res.status(400).send('Invalid or missing session ID');
        return;
    }

    const lastEventId = req.headers['last-event-id'] as string | undefined;
    if (lastEventId) {
        console.log(`[SSE] Client reconnecting with Last-Event-ID: ${lastEventId}`);
    } else {
        console.log(`[SSE] Establishing new stream for session ${sessionId}`);
    }

    await session.transport.handleRequest(req, res);
};

app.get('/mcp', mcpGetHandler);

/**
 * MCP DELETE endpoint handler for session termination.
 */
const mcpDeleteHandler = async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const session = sessionId ? sessions.get(sessionId) : undefined;

    if (!session) {
        res.status(400).send('Invalid or missing session ID');
        return;
    }

    console.log(`[SESSION] Termination request for session ${sessionId}`);

    try {
        await session.transport.handleRequest(req, res);
    } catch (error) {
        console.error('[ERROR] Session termination:', error);
        if (!res.headersSent) {
            res.status(500).send('Error processing session termination');
        }
    }
};

app.delete('/mcp', mcpDeleteHandler);

// ═══════════════════════════════════════════════════════════════════════════
// Server Startup
// ═══════════════════════════════════════════════════════════════════════════

app.listen(PORT, error => {
    if (error) {
        console.error('Failed to start server:', error);
        // eslint-disable-next-line unicorn/no-process-exit
        process.exit(1);
    }
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('MCP Builder Example Server');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`Listening on port ${PORT}`);
    console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
    console.log('');
    console.log('Features demonstrated:');
    console.log('  - Builder pattern for server configuration');
    console.log('  - Universal middleware (logging)');
    console.log('  - Tool-specific middleware (metrics)');
    console.log('  - Per-tool middleware (authorization)');
    console.log('  - Error handlers (onError, onProtocolError)');
    console.log('  - Context helpers (logging, notifications)');
    console.log('═══════════════════════════════════════════════════════════════');
});

// ═══════════════════════════════════════════════════════════════════════════
// Graceful Shutdown
// ═══════════════════════════════════════════════════════════════════════════

process.on('SIGINT', async () => {
    console.log('\n[SHUTDOWN] Received SIGINT, shutting down...');

    // Close all sessions
    for (const [sid, session] of sessions) {
        try {
            console.log(`[SHUTDOWN] Closing session ${sid}`);
            await session.transport.close();
        } catch (error) {
            console.error(`[SHUTDOWN] Error closing session ${sid}:`, error);
        }
    }

    // Clear the sessions map
    sessions.clear();

    console.log('[SHUTDOWN] Complete');
    process.exit(0);
});
