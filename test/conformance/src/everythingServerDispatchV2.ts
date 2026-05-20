#!/usr/bin/env node

/**
 * MCP conformance server for the dispatch-v2 architecture.
 *
 * Stateless (2026-06) requests are served by `handleHttp(server)` — one shared
 * `Server` instance, no transport class, no connect(). Legacy (pre-2026)
 * requests are served by the existing user-session-map pattern with a
 * per-session `NodeStreamableHTTPServerTransport`. The `app.all` handler routes
 * by `MCP-Protocol-Version` header (falling back to `_meta.protocolVersion`
 * from the parsed body).
 *
 * This demonstrates the design intent: 2026-06 path is RFC-simple (handleHttp),
 * pre-2026 path is unchanged.
 */

import { localhostHostValidation } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { isInitializeRequest, isStatelessProtocolVersion, META_KEYS, statelessHttpHandler } from '@modelcontextprotocol/server';
import cors from 'cors';
import type { Request, Response } from 'express';
import express from 'express';

import { createEventStore, createMcpServer } from './everythingServerSetup.js';

// One shared server for the stateless path.
const sharedServer = createMcpServer({ closeSSEForReconnectTest: () => {} }).server;
const handlers = sharedServer.statelessHandlers();

// Per-session transports for the legacy path.
const sessions: Record<string, NodeStreamableHTTPServerTransport> = {};

function statelessVersion(req: Request): string | undefined {
    const h = req.get('mcp-protocol-version');
    if (h) return isStatelessProtocolVersion(h) ? h : undefined;
    const body = req.body;
    const first = Array.isArray(body) ? body[0] : body;
    const v = first?.params?._meta?.[META_KEYS.protocolVersion];
    return typeof v === 'string' && isStatelessProtocolVersion(v) ? v : undefined;
}

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

app.all('/mcp', async (req: Request, res: Response) => {
    try {
        // 2026-06 → statelessHttpHandler (no Transport, no session).
        if (statelessVersion(req)) {
            const fReq = new globalThis.Request(`http://${req.get('host') ?? 'localhost'}${req.url}`, {
                method: req.method,
                headers: Object.entries(req.headers).flatMap(([k, v]) => (typeof v === 'string' ? [[k, v]] : [])) as [string, string][]
            });
            const fRes = await statelessHttpHandler(handlers, fReq, { parsedBody: req.body });
            res.status(fRes.status);
            for (const [k, v] of fRes.headers.entries()) res.setHeader(k, v);
            if (fRes.body) {
                const reader = fRes.body.getReader();
                req.on('close', () => void reader.cancel().catch(() => {}));
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    res.write(Buffer.from(value));
                }
            }
            res.end();
            return;
        }

        // Pre-2026 → user-owned session map (unchanged from existing pattern).
        const sid = req.get('mcp-session-id');
        if (sid && sessions[sid]) {
            return sessions[sid]!.handleRequest(req, res, req.body);
        }
        if (req.method === 'POST' && isInitializeRequest(req.body)) {
            const mcp = createMcpServer({ closeSSEForReconnectTest: ctx => ctx.http?.closeSSE?.() });
            const transport = new NodeStreamableHTTPServerTransport({
                sessionIdGenerator: () => crypto.randomUUID(),
                eventStore: createEventStore(),
                onsessioninitialized: id => {
                    sessions[id] = transport;
                }
            });
            await mcp.connect(transport);
            return transport.handleRequest(req, res, req.body);
        }
        if (sid) {
            res.status(404).json({ jsonrpc: '2.0', error: { code: -32_001, message: 'Session not found' }, id: null });
        } else {
            res.status(400).json({ jsonrpc: '2.0', error: { code: -32_600, message: 'Bad Request: missing session ID' }, id: null });
        }
    } catch (error) {
        console.error('Error handling MCP request:', error);
        if (!res.headersSent) {
            res.status(500).json({ jsonrpc: '2.0', error: { code: -32_603, message: 'Internal server error' }, id: null });
        }
    }
});

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () => {
    console.log(`MCP Conformance Test Server (dispatch-v2: handleHttp + legacy session map) on http://localhost:${PORT}/mcp`);
});
