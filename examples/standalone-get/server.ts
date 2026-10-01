/**
 * Standalone GET stream + `notifications/resources/list_changed` (sessionful
 * 2025).
 *
 * One `NodeStreamableHTTPServerTransport` + `McpServer` per session, the way
 * you would deploy a sessionful 2025 server. The `add_resource` tool registers
 * a new resource on the session's instance — `McpServer.registerResource` emits
 * `notifications/resources/list_changed`, which on a sessionful transport
 * travels over the **standalone GET** SSE stream the client opened. The client
 * decides when to mutate (no timer race with the runner).
 *
 * **HTTP-only**, sessionful 2025 by definition — so the canonical
 * `serveStdio` / `createMcpHandler` shape does not apply (per-request stateless
 * has no GET stream).
 */
import { randomUUID } from 'node:crypto';

import { parseExampleArgs } from '@mcp-examples/shared';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { isInitializeRequest, McpServer } from '@modelcontextprotocol/server';
import type { Request, Response } from 'express';
import * as z from 'zod/v4';

function buildServer(): McpServer {
    const server = new McpServer(
        { name: 'standalone-get-example', version: '1.0.0' },
        { capabilities: { resources: { listChanged: true } } }
    );
    let nextId = 1;
    const register = (name: string, content: string) =>
        server.registerResource(
            name,
            `https://mcp-example.com/dynamic/${encodeURIComponent(name)}`,
            { mimeType: 'text/plain' },
            async uri => ({
                contents: [{ uri: uri.href, mimeType: 'text/plain', text: content }]
            })
        );
    register('initial', 'Initial content');

    server.registerTool(
        'add_resource',
        {
            description:
                'Register a new resource on this session — emits notifications/resources/list_changed over the standalone GET stream.',
            inputSchema: z.object({ content: z.string() })
        },
        async ({ content }) => {
            const name = `note-${nextId++}`;
            register(name, content);
            return { content: [{ type: 'text', text: `registered ${name}` }] };
        }
    );
    return server;
}

const IDLE_MS = 30 * 60_000;
const MAX_SESSIONS = 10_000;

type Session = { transport: NodeStreamableHTTPServerTransport; open: number; lastActive: number };
const sessions = new Map<string, Session>();
const app = createMcpExpressApp();

// Count open responses so a long-running request or a listening stream is not treated as idle.
const trackResponse = (session: Session, res: Response) => {
    if (!res.socket || res.destroyed) return;
    session.open++;
    res.on('close', () => {
        session.open--;
        session.lastActive = Date.now();
    });
};

app.post('/mcp', async (req: Request, res: Response) => {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    const session = sid ? sessions.get(sid) : undefined;
    if (session) {
        trackResponse(session, res);
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
        await buildServer().connect(transport);
        await transport.handleRequest(req, res, req.body);
    } else if (sid) {
        res.status(404).json({ jsonrpc: '2.0', error: { code: -32_001, message: 'Session not found' }, id: null });
    } else {
        res.status(400).json({ jsonrpc: '2.0', error: { code: -32_000, message: 'Bad Request: Session ID required' }, id: null });
    }
});

// The standalone GET stream (the point of this story) and DELETE (explicit
// session termination per the MCP spec) route to the session's transport.
const sessionVerb = async (req: Request, res: Response) => {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    const session = sid ? sessions.get(sid) : undefined;
    if (!session) {
        res.status(sid ? 404 : 400).send(sid ? 'Session not found' : 'Missing session ID');
        return;
    }
    trackResponse(session, res);
    await session.transport.handleRequest(req, res);
};
app.get('/mcp', sessionVerb);
app.delete('/mcp', sessionVerb);

// Close sessions with nothing open and no activity for IDLE_MS.
setInterval(() => {
    const cutoff = Date.now() - IDLE_MS;
    for (const { transport, open, lastActive } of sessions.values()) {
        if (open === 0 && lastActive < cutoff) void transport.close();
    }
}, 60_000).unref();

const { port } = parseExampleArgs();
app.listen(port, () => {
    console.error(`[server] listening on http://127.0.0.1:${port}/mcp`);
});
