#!/usr/bin/env node

/**
 * MCP conformance server — `transport.connect()` API path.
 *
 * Per-session `NodeStreamableHTTPServerTransport` instances created on `initialize` and
 * looked up by `mcp-session-id` thereafter (the v1.x API surface). Registrations come
 * from {@linkcode ./everythingServerSetup.ts}; this file is the express + transport
 * wiring only.
 *
 * Sibling: {@linkcode ./everythingServerHandleHttp.ts} drives the same registrations via
 * `handleHttp()` / `shttpHandler` so CI can prove both API surfaces stay conformant.
 */

import { randomUUID } from 'node:crypto';

import { localhostHostValidation } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { McpServer } from '@modelcontextprotocol/server';
import { isInitializeRequest } from '@modelcontextprotocol/server';
import cors from 'cors';
import type { Request, Response } from 'express';
import express from 'express';

import { createEventStore, createMcpServer } from './everythingServerSetup.js';

const transports: { [sessionId: string]: NodeStreamableHTTPServerTransport } = {};
const servers: { [sessionId: string]: McpServer } = {};

const app = express();
app.use(express.json());
app.use(localhostHostValidation());
app.use(
    cors({
        origin: '*',
        exposedHeaders: ['Mcp-Session-Id'],
        allowedHeaders: ['Content-Type', 'mcp-session-id', 'last-event-id']
    })
);

app.post('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
        let transport: NodeStreamableHTTPServerTransport;

        if (sessionId && transports[sessionId]) {
            transport = transports[sessionId];
        } else if (!sessionId && isInitializeRequest(req.body)) {
            const mcpServer = createMcpServer({
                closeSSEForReconnectTest: ctx => {
                    const sid = ctx.sessionId;
                    const t = sid ? transports[sid] : undefined;
                    if (t && ctx.mcpReq.id) t.closeSSEStream(ctx.mcpReq.id);
                }
            });

            transport = new NodeStreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                eventStore: createEventStore(),
                retryInterval: 5000,
                onsessioninitialized: (newSessionId: string) => {
                    transports[newSessionId] = transport;
                    servers[newSessionId] = mcpServer;
                    console.log(`Session initialized with ID: ${newSessionId}`);
                }
            });

            transport.onclose = () => {
                const sid = transport.sessionId;
                if (sid && transports[sid]) {
                    delete transports[sid];
                    if (servers[sid]) {
                        servers[sid].close();
                        delete servers[sid];
                    }
                    console.log(`Session ${sid} closed`);
                }
            };

            await mcpServer.connect(transport);
            await transport.handleRequest(req, res, req.body);
            return;
        } else if (sessionId) {
            res.status(404).json({ jsonrpc: '2.0', error: { code: -32_001, message: 'Session not found' }, id: null });
            return;
        } else {
            res.status(400).json({ jsonrpc: '2.0', error: { code: -32_000, message: 'Bad Request: Session ID required' }, id: null });
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

app.get('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId) {
        res.status(400).send('Missing session ID');
        return;
    }
    if (!transports[sessionId]) {
        res.status(404).send('Session not found');
        return;
    }

    const lastEventId = req.headers['last-event-id'] as string | undefined;
    if (lastEventId) {
        console.log(`Client reconnecting with Last-Event-ID: ${lastEventId}`);
    } else {
        console.log(`Establishing SSE stream for session ${sessionId}`);
    }

    try {
        const transport = transports[sessionId];
        await transport.handleRequest(req, res);
    } catch (error) {
        console.error('Error handling SSE stream:', error);
        if (!res.headersSent) {
            res.status(500).send('Error establishing SSE stream');
        }
    }
});

app.delete('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId) {
        res.status(400).send('Missing session ID');
        return;
    }
    if (!transports[sessionId]) {
        res.status(404).send('Session not found');
        return;
    }

    console.log(`Received session termination request for session ${sessionId}`);

    try {
        const transport = transports[sessionId];
        await transport.handleRequest(req, res);
    } catch (error) {
        console.error('Error handling termination:', error);
        if (!res.headersSent) {
            res.status(500).send('Error processing session termination');
        }
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`MCP Conformance Test Server (transport.connect path) running on http://localhost:${PORT}`);
    console.log(`  - MCP endpoint: http://localhost:${PORT}/mcp`);
});
