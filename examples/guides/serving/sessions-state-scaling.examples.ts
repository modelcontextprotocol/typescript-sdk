// docs: typecheck-only
/**
 * Companion example for `docs/serving/sessions-state-scaling.md`.
 *
 * Every `ts` fence on that page is synced from a `//#region` in this file
 * (`pnpm sync:snippets --check`). The regions are fragments of an HTTP
 * deployment — transport options, an Express route, a handler option — and
 * none of them may bind a port, so the file is typecheck-only.
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *
 * @module
 */

// "Sessions" lead block — sessionIdGenerator turns sessions on for the
// hand-wired 2025-era Streamable HTTP transport.
//#region sessions_stateful
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { randomUUID } from 'node:crypto';

const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID()
});
//#endregion sessions_stateful
void transport;

// Imports for the function-wrapped regions below, kept out of the page's lead block.
import type { EventStore, McpServer, ServerEventBus } from '@modelcontextprotocol/server';
import { createMcpHandler, isInitializeRequest } from '@modelcontextprotocol/server';
import type { Express, Request, Response } from 'express';

/**
 * "Sessions" follow-up — one transport per session, routed by `Mcp-Session-Id`
 * (mined from `examples/legacy-routing/server.ts`).
 */
function sessions_routing(app: Express, buildServer: () => McpServer) {
    //#region sessions_routing
    const IDLE_MS = 30 * 60_000;
    const MAX_SESSIONS = 10_000;

    type Session = { transport: NodeStreamableHTTPServerTransport; open: number; lastActive: number };
    const sessions = new Map<string, Session>();

    const route = async (req: Request, res: Response) => {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        const session = sessionId ? sessions.get(sessionId) : undefined;
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
            return;
        }
        if (!sessionId && isInitializeRequest(req.body)) {
            if (sessions.size >= MAX_SESSIONS) {
                res.status(503).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Too many open sessions' }, id: null });
                return;
            }
            const transport = new NodeStreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: id => {
                    sessions.set(id, { transport, open: 0, lastActive: Date.now() });
                }
            });
            transport.onclose = () => {
                if (transport.sessionId) sessions.delete(transport.sessionId);
            };
            await buildServer().connect(transport);
            await transport.handleRequest(req, res, req.body);
            return;
        }
        if (sessionId) {
            // Unknown session id: the client should start a new session.
            res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
            return;
        }
        // No session header on a non-initialize request: the request is malformed.
        res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: Session ID required' }, id: null });
    };

    app.post('/mcp', route);
    app.get('/mcp', route);
    app.delete('/mcp', route);

    // Close sessions with nothing open and no activity for IDLE_MS.
    setInterval(() => {
        const cutoff = Date.now() - IDLE_MS;
        for (const { transport, open, lastActive } of sessions.values()) {
            if (open === 0 && lastActive < cutoff) void transport.close();
        }
    }, 60_000).unref();
    //#endregion sessions_routing
}
void sessions_routing;

/** "Resumability" — an EventStore implementation next to sessionIdGenerator. */
function resumability_eventStore(databaseEventStore: EventStore) {
    //#region resumability_eventStore
    const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        eventStore: databaseEventStore
    });
    //#endregion resumability_eventStore
    return transport;
}
void resumability_eventStore;

/** "Multi-node" — every node hands the same pub/sub-backed bus to createMcpHandler. */
function multiNode_bus(buildServer: () => McpServer, redisBus: ServerEventBus) {
    //#region multiNode_bus
    const handler = createMcpHandler(buildServer, { bus: redisBus });
    //#endregion multiNode_bus
    return handler;
}
void multiNode_bus;
