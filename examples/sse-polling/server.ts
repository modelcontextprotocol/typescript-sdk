/**
 * SSE Polling Example Server (SEP-1699)
 *
 * This example demonstrates server-initiated SSE stream disconnection
 * and client reconnection with Last-Event-ID for resumability.
 *
 * Key features:
 * - Configures `retryInterval` to tell clients how long to wait before reconnecting
 * - Uses `eventStore` to persist events for replay after reconnection
 * - Uses `ctx.http?.closeSSE()` callback to gracefully disconnect clients mid-operation
 *
 * HTTP-only, sessionful 2025 by definition.
 */
import { randomUUID } from 'node:crypto';

import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { isInitializeRequest, McpServer } from '@modelcontextprotocol/server';
import cors from 'cors';
import type { Request, Response } from 'express';

import { InMemoryEventStore } from './inMemoryEventStore.js';

// Create a fresh MCP server per client connection to avoid shared state between clients
const getServer = () => {
    const server = new McpServer(
        {
            name: 'sse-polling-example',
            version: '1.0.0'
        },
        {
            capabilities: { logging: {} }
        }
    );

    // Register a long-running tool that demonstrates server-initiated disconnect
    server.registerTool(
        'long-operation',
        {
            description: 'A long-running operation that sends progress updates. Server will disconnect mid-stream to demonstrate polling.'
        },
        async (ctx): Promise<CallToolResult> => {
            const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

            console.error(`[${ctx.sessionId}] Starting long-operation...`);

            // Send first progress notification
            await ctx.mcpReq.log('info', 'Progress: 25% - Starting work...');
            await sleep(200);

            // Send second progress notification
            await ctx.mcpReq.log('info', 'Progress: 50% - Halfway there...');
            await sleep(200);

            // Server decides to disconnect the client to free resources
            // Client will reconnect via GET with Last-Event-ID after the transport's retryInterval
            // Use ctx.http?.closeSSE callback - available when eventStore is configured
            if (ctx.http?.closeSSE) {
                console.error(`[${ctx.sessionId}] Closing SSE stream to trigger client polling...`);
                ctx.http?.closeSSE();
            }

            // Continue processing while client is disconnected
            // Events are stored in eventStore and will be replayed on reconnect
            await sleep(200);
            await ctx.mcpReq.log('info', 'Progress: 75% - Almost done (sent while client disconnected)...');

            await sleep(200);
            await ctx.mcpReq.log('info', 'Progress: 100% - Complete!');

            console.error(`[${ctx.sessionId}] Operation complete`);

            return {
                content: [
                    {
                        type: 'text',
                        text: 'Long operation completed successfully!'
                    }
                ]
            };
        }
    );

    return server;
};

// Set up Express app
const app = createMcpExpressApp();
app.use(cors());

// Create event store for resumability
const eventStore = new InMemoryEventStore();

// Track transports by session ID for session reuse
const transports = new Map<string, NodeStreamableHTTPServerTransport>();

// Handle all MCP requests (standard sessionful routing: known sid → reuse;
// no sid + initialize → new session; unknown sid → 404; otherwise → 400).
app.all('/mcp', async (req: Request, res: Response) => {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    if (sid && transports.has(sid)) {
        await transports.get(sid)!.handleRequest(req, res, req.body);
    } else if (!sid && isInitializeRequest(req.body)) {
        const transport = new NodeStreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            eventStore,
            retryInterval: 300, // Default retry interval for priming events
            onsessioninitialized: id => {
                console.error(`[${id}] Session initialized`);
                transports.set(id, transport);
            }
        });
        transport.onclose = () => transport.sessionId && transports.delete(transport.sessionId);
        await getServer().connect(transport);
        await transport.handleRequest(req, res, req.body);
    } else if (sid) {
        // Unknown/expired session ID → 404 so the client knows to re-initialize.
        res.status(404).json({ jsonrpc: '2.0', error: { code: -32_001, message: 'Session not found' }, id: null });
    } else {
        res.status(400).json({ jsonrpc: '2.0', error: { code: -32_000, message: 'Bad Request: Session ID required' }, id: null });
    }
});

// Start the server
const argv = process.argv.slice(2);
const portIdx = argv.indexOf('--port');
const PORT = portIdx === -1 ? Number(process.env.PORT ?? 3001) : Number(argv[portIdx + 1]);
app.listen(PORT, () => {
    console.error(`SSE Polling Example Server running on http://localhost:${PORT}/mcp`);
    console.error('This server demonstrates SEP-1699 SSE polling:');
    console.error('- retryInterval: 300ms (client waits before reconnecting)');
    console.error('- eventStore: InMemoryEventStore (events are persisted for replay)');
    console.error('Try calling the "long-operation" tool to see server-initiated disconnect in action.');
});
