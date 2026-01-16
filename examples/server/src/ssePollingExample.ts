/**
 * SSE Polling Example Server (SEP-1699)
 *
 * This example demonstrates server-initiated SSE stream disconnection
 * and client reconnection with Last-Event-ID for resumability.
 *
 * Key features:
 * - Configures `retryInterval` to tell clients how long to wait before reconnecting
 * - Uses `eventStore` to persist events for replay after reconnection
 * - Uses `extra.closeSSEStream()` callback to gracefully disconnect clients mid-operation
 *
 * Run with: pnpm tsx src/ssePollingExample.ts
 * Test with: curl or the MCP Inspector
 */
import { randomUUID } from 'node:crypto';

import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { McpServer } from '@modelcontextprotocol/server';
import cors from 'cors';
import type { Request, Response } from 'express';

import { InMemoryEventStore } from './inMemoryEventStore.js';

// Create the MCP server
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
server.tool(
    'long-task',
    'A long-running task that sends progress updates. Server will disconnect mid-task to demonstrate polling.',
    {},
    async (_args, extra): Promise<CallToolResult> => {
        const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

        console.log(`[${extra.sessionId}] Starting long-task...`);

        // Send first progress notification
        await server.sendLoggingMessage(
            {
                level: 'info',
                data: 'Progress: 25% - Starting work...'
            },
            extra.sessionId
        );
        await sleep(1000);

        // Send second progress notification
        await server.sendLoggingMessage(
            {
                level: 'info',
                data: 'Progress: 50% - Halfway there...'
            },
            extra.sessionId
        );
        await sleep(1000);

        // Server decides to disconnect the client to free resources
        // Client will reconnect via GET with Last-Event-ID after the transport's retryInterval
        // Use extra.closeSSEStream callback - available when eventStore is configured
        if (extra.closeSSEStream) {
            console.log(`[${extra.sessionId}] Closing SSE stream to trigger client polling...`);
            extra.closeSSEStream();
        }

        // Continue processing while client is disconnected
        // Events are stored in eventStore and will be replayed on reconnect
        await sleep(500);
        await server.sendLoggingMessage(
            {
                level: 'info',
                data: 'Progress: 75% - Almost done (sent while client disconnected)...'
            },
            extra.sessionId
        );

        await sleep(500);
        await server.sendLoggingMessage(
            {
                level: 'info',
                data: 'Progress: 100% - Complete!'
            },
            extra.sessionId
        );

        console.log(`[${extra.sessionId}] Task complete`);

        return {
            content: [
                {
                    type: 'text',
                    text: 'Long task completed successfully!'
                }
            ]
        };
    }
);

// Set up Express app
const app = createMcpExpressApp();
app.use(cors());

// Create event store for resumability
const eventStore = new InMemoryEventStore();

// Track transports by session ID for session reuse
const transports = new Map<string, NodeStreamableHTTPServerTransport>();

// Handle all MCP requests
app.all('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    // Reuse existing transport or create new one
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
        transport = new NodeStreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            eventStore,
            retryInterval: 2000, // Default retry interval for priming events
            onsessioninitialized: id => {
                console.log(`[${id}] Session initialized`);
                transports.set(id, transport!);
            }
        });

        // Connect the MCP server to the transport
        await server.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
});

// Start the server
const PORT = 3001;
app.listen(PORT, () => {
    console.log(`SSE Polling Example Server running on http://localhost:${PORT}/mcp`);
    console.log('');
    console.log('This server demonstrates SEP-1699 SSE polling:');
    console.log('- retryInterval: 2000ms (client waits 2s before reconnecting)');
    console.log('- eventStore: InMemoryEventStore (events are persisted for replay)');
    console.log('');
    console.log('Try calling the "long-task" tool to see server-initiated disconnect in action.');
});
