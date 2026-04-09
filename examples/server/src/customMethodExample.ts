// Run with: pnpm tsx src/customMethodExample.ts
//
// Demonstrates registering handlers for custom (non-standard) request methods
// and sending custom notifications back to the client.
//
// The Protocol class exposes setCustomRequestHandler / sendCustomNotification for
// vendor-specific methods that are not part of the MCP spec. Params are validated
// against user-provided Zod schemas, and handlers receive the same context
// (cancellation, bidirectional send/notify) as standard handlers.
//
// Pair with: examples/client/src/customMethodExample.ts

import { randomUUID } from 'node:crypto';

import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { isInitializeRequest, Server } from '@modelcontextprotocol/server';
import type { Request, Response } from 'express';
import { z } from 'zod';

const SearchParamsSchema = z.object({
    query: z.string(),
    limit: z.number().int().positive().optional()
});

const AnalyticsParamsSchema = z.object({
    event: z.string(),
    properties: z.record(z.string(), z.unknown()).optional()
});

const getServer = () => {
    const server = new Server({ name: 'custom-method-server', version: '1.0.0' }, { capabilities: {} });

    server.setCustomRequestHandler('acme/search', SearchParamsSchema, async (params, ctx) => {
        console.log(`[server] acme/search query="${params.query}" limit=${params.limit ?? 'unset'} (req ${ctx.mcpReq.id})`);

        // Send a custom server→client notification on the same SSE stream as this response
        // (relatedRequestId routes it to the request's stream rather than the standalone SSE stream).
        await server.sendCustomNotification(
            'acme/statusUpdate',
            { status: 'busy', detail: `searching "${params.query}"` },
            { relatedRequestId: ctx.mcpReq.id }
        );

        return {
            results: [
                { id: 'r1', title: `Result for "${params.query}"` },
                { id: 'r2', title: 'Another result' }
            ],
            total: 2
        };
    });

    server.setCustomRequestHandler('acme/analytics', AnalyticsParamsSchema, async params => {
        console.log(`[server] acme/analytics event="${params.event}"`);
        return { recorded: true };
    });

    return server;
};

const PORT = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 3000;
const app = createMcpExpressApp();
const transports: { [sessionId: string]: NodeStreamableHTTPServerTransport } = {};

app.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    try {
        let transport: NodeStreamableHTTPServerTransport;
        if (sessionId && transports[sessionId]) {
            transport = transports[sessionId];
        } else if (!sessionId && isInitializeRequest(req.body)) {
            transport = new NodeStreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: sid => {
                    transports[sid] = transport;
                }
            });
            transport.onclose = () => {
                const sid = transport.sessionId;
                if (sid) delete transports[sid];
            };
            const server = getServer();
            await server.connect(transport);
        } else {
            res.status(400).json({ jsonrpc: '2.0', error: { code: -32_000, message: 'No valid session ID' }, id: null });
            return;
        }
        await transport.handleRequest(req, res, req.body);
    } catch (error) {
        console.error('Error handling MCP request:', error);
        if (!res.headersSent) {
            res.status(500).json({ jsonrpc: '2.0', error: { code: -32_603, message: 'Internal server error' }, id: null });
        }
    }
});

const handleSessionRequest = async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
    }
    await transports[sessionId].handleRequest(req, res);
};

app.get('/mcp', handleSessionRequest);
app.delete('/mcp', handleSessionRequest);

app.listen(PORT, error => {
    if (error) {
        console.error('Failed to start server:', error);
        // eslint-disable-next-line unicorn/no-process-exit
        process.exit(1);
    }
    console.log(`Custom-method example server listening on http://localhost:${PORT}/mcp`);
    console.log('Custom methods: acme/search, acme/analytics');
});

process.on('SIGINT', async () => {
    for (const sid in transports) await transports[sid]!.close();
    process.exit(0);
});
