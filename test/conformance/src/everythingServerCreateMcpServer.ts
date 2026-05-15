#!/usr/bin/env node

/**
 * MCP conformance server using the `createMcpServer` router-mode option.
 *
 * One `NodeStreamableHTTPServerTransport` instance handles BOTH legacy
 * (pre-2026, session-managed) and 2026-06 stateless requests. Version
 * routing and session management are owned by the transport.
 *
 * This is the unified target intended to pass the full `--spec-version draft`
 * suite (carry-forward scenarios + server-stateless) without user-side
 * session-map boilerplate.
 *
 * Siblings:
 * - {@linkcode ./everythingServer.ts} — user-owned session map (legacy API surface).
 * - {@linkcode ./everythingServerHandleStatelessHttp.ts} — stateless-only entry.
 */

import { randomUUID } from 'node:crypto';

import { localhostHostValidation } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import cors from 'cors';
import express from 'express';

import { createEventStore, createMcpServer } from './everythingServerSetup.js';

const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    eventStore: createEventStore(),
    createMcpServer: () => createMcpServer({ closeSSEForReconnectTest: ctx => ctx.http?.closeSSE?.() })
});

const app = express();
app.use(express.json());
app.use(localhostHostValidation());
app.use(
    cors({
        origin: '*',
        exposedHeaders: ['Mcp-Session-Id'],
        allowedHeaders: ['Content-Type', 'mcp-session-id', 'last-event-id', 'mcp-protocol-version']
    })
);

app.all('/mcp', async (req, res) => {
    try {
        await transport.handleRequest(req, res, req.body);
    } catch (error) {
        console.error('Error handling MCP request:', error);
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: '2.0',
                error: { code: -32_603, message: 'Internal server error' },
                id: null
            });
        }
    }
});

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () => {
    console.log(`MCP Conformance Test Server (createMcpServer router mode) running on http://localhost:${PORT}`);
    console.log(`  - MCP endpoint: http://localhost:${PORT}/mcp`);
});
