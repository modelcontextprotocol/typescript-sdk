/**
 * Demonstrates: McpServer + HttpVersionRouter with session management
 *
 * Modern (2026-06) requests are stateless — no sessions needed.
 * Legacy (2025-11) requests use sessions via the building-blocks API
 * (classify / handleModernRequest / createLegacySession).
 *
 * This is a simplified example that only handles POST. A production
 * server would also handle GET (SSE) and DELETE (session termination).
 */

import { createMcpExpressApp } from '@modelcontextprotocol/express';
import type { LegacySession } from '@modelcontextprotocol/server';
import { HttpVersionRouter, McpServer } from '@modelcontextprotocol/server';
import type { Request, Response } from 'express';
import * as z from 'zod/v4';

const server = new McpServer({
    name: 'version-router-http-example',
    version: '1.0.0'
});

server.registerTool(
    'echo',
    {
        description: 'Echoes back the input',
        inputSchema: z.object({ message: z.string() })
    },
    async ({ message }) => ({
        content: [{ type: 'text', text: message }]
    })
);

const router = new HttpVersionRouter(server);

// Session store for legacy clients
const sessions: Record<string, LegacySession> = {};

const app = createMcpExpressApp();

app.post('/mcp', async (req: Request, res: Response) => {
    const headers = req.headers as Record<string, string>;

    // Modern requests bypass sessions entirely
    if (router.classify(req.body, { httpHeaders: headers }) === 'modern') {
        try {
            const result = await router.handleModernRequest(req.body, {
                httpHeaders: headers
            });
            res.json({ jsonrpc: '2.0', id: req.body.id, result });
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Internal error';
            res.status(500).json({
                jsonrpc: '2.0',
                id: req.body.id,
                error: { code: -32_603, message }
            });
        }
        return;
    }

    // Legacy: session management
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && sessions[sessionId]) {
        // Existing session — inject the message, respond via onOutgoing
        const session = sessions[sessionId]!;
        session.onOutgoing = msg => {
            if (!res.headersSent) {
                res.setHeader('mcp-session-id', session.id);
                res.json(msg);
            }
        };
        session.injectMessage(req.body);
    } else if (!sessionId && req.body.method === 'initialize') {
        // New legacy session
        const session = router.createLegacySession();
        sessions[session.id] = session;
        session.onclose = () => delete sessions[session.id];

        session.onOutgoing = msg => {
            if (!res.headersSent) {
                res.setHeader('mcp-session-id', session.id);
                res.json(msg);
            }
        };
        session.injectMessage(req.body);
    } else {
        res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32_000, message: 'Missing or invalid session' },
            id: req.body.id ?? null
        });
    }
});

const PORT = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 3000;
app.listen(PORT, () => {
    console.log(`MCP server with version routing on http://localhost:${PORT}/mcp`);
    console.log('Supports both legacy (initialize) and modern (server/discover) clients.');
});
