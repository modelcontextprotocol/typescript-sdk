/**
 * `isLegacyRequest` routing in front of an existing sessionful 1.x deployment,
 * with a strict modern entry on the SAME port.
 *
 * This is the v2 answer to "I already have a sessionful Streamable HTTP
 * deployment and want to add 2026-07-28 serving without disturbing it":
 * route in user land — `await isLegacyRequest(req)` decides per request,
 * legacy traffic goes to your existing transport, modern traffic to a strict
 * `createMcpHandler(factory, { legacy: 'reject' })`.
 *
 * HTTP-only by definition.
 */
import { randomUUID } from 'node:crypto';

import { parseExampleArgs } from '@mcp-examples/shared';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport, toNodeHandler, toWebRequest } from '@modelcontextprotocol/node';
import type { McpRequestContext } from '@modelcontextprotocol/server';
import { createMcpHandler, isInitializeRequest, isLegacyRequest, McpServer } from '@modelcontextprotocol/server';
import cors from 'cors';
import type { Request, Response } from 'express';
import * as z from 'zod/v4';

// One factory for both legs.
const buildServer = (era: 'legacy' | 'modern') => {
    const server = new McpServer({ name: 'legacy-routing-example', version: '1.0.0' });
    server.registerTool('greet', { description: 'Greets the caller', inputSchema: z.object({ name: z.string() }) }, async ({ name }) => ({
        content: [{ type: 'text', text: `Hello, ${name}! (era=${era})` }]
    }));
    return server;
};

// --- the existing sessionful 2025 deployment, unchanged ---
const IDLE_MS = 30 * 60_000;
const MAX_SESSIONS = 10_000;

type Session = { transport: NodeStreamableHTTPServerTransport; open: number; lastActive: number };
const sessions = new Map<string, Session>();
const handleLegacy = async (req: Request, res: Response) => {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    const session = sid ? sessions.get(sid) : undefined;
    if (session) {
        // Count open responses so a long-running request or a listening stream is not treated as idle.
        if (res.socket && !res.destroyed) {
            session.open++;
            res.on('close', () => {
                session.open--;
                session.lastActive = Date.now();
            });
        }
        await session.transport.handleRequest(req, res, req.body);
    } else if (!sid && isInitializeRequest(req.body)) {
        if (sessions.size >= MAX_SESSIONS) {
            res.status(503).json({ jsonrpc: '2.0', error: { code: -32_000, message: 'Too many open sessions' }, id: null });
            return;
        }
        const transport = new NodeStreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: id => {
                sessions.set(id, { transport, open: 0, lastActive: Date.now() });
            }
        });
        transport.onclose = () => transport.sessionId && sessions.delete(transport.sessionId);
        await buildServer('legacy').connect(transport);
        await transport.handleRequest(req, res, req.body);
    } else if (sid) {
        // Unknown session ID → 404 so the client knows to start a new session.
        res.status(404).json({ jsonrpc: '2.0', error: { code: -32_001, message: 'Session not found' }, id: null });
    } else {
        res.status(400).json({ jsonrpc: '2.0', error: { code: -32_000, message: 'Bad Request: Session ID required' }, id: null });
    }
};

// Close sessions with nothing open and no activity for IDLE_MS.
setInterval(() => {
    const cutoff = Date.now() - IDLE_MS;
    for (const { transport, open, lastActive } of sessions.values()) {
        if (open === 0 && lastActive < cutoff) void transport.close();
    }
}, 60_000).unref();

// --- the strict modern entry alongside it ---
const modern = createMcpHandler((ctx: McpRequestContext) => buildServer(ctx.era), { legacy: 'reject' });
const modernNode = toNodeHandler(modern);

const app = createMcpExpressApp();
// Browser-client CORS recipe: expose the response headers a browser-based MCP
// client must be able to read (`Mcp-Session-Id` for session correlation,
// `WWW-Authenticate` for the auth challenge, `Last-Event-Id` for resumability,
// `Mcp-Protocol-Version` for negotiation). DEMO ONLY — restrict `origin` in
// production.
app.use(
    cors({
        origin: '*',
        exposedHeaders: ['Mcp-Session-Id', 'WWW-Authenticate', 'Last-Event-Id', 'Mcp-Protocol-Version']
    })
);

app.post('/mcp', async (req: Request, res: Response) => {
    // `toWebRequest` builds the web-standard `Request` the predicate takes.
    // Express has already parsed (and consumed) the JSON body — pass it along.
    const probe = await toWebRequest(req, req.body);
    await ((await isLegacyRequest(probe)) ? handleLegacy(req, res) : modernNode(req, res, req.body));
});
// GET (standalone SSE stream / reconnect with Last-Event-ID) and DELETE
// (explicit session termination per the MCP spec) are sessionful-2025-only —
// route them straight to the legacy arm; the transport handles each verb.
app.get('/mcp', (req, res) => void handleLegacy(req, res));
app.delete('/mcp', (req, res) => void handleLegacy(req, res));

const { port } = parseExampleArgs();
app.listen(port, () => {
    console.error(`[server] listening on http://127.0.0.1:${port}/mcp`);
});
