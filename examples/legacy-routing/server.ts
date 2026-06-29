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
const sessions = new Map<string, NodeStreamableHTTPServerTransport>();
const handleLegacy = async (req: Request, res: Response) => {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    if (sid && sessions.has(sid)) {
        await sessions.get(sid)!.handleRequest(req, res, req.body);
    } else if (!sid && isInitializeRequest(req.body)) {
        const transport = new NodeStreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: id => {
                sessions.set(id, transport);
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
    // `toWebRequest` converts the Node request into the web-standard `Request`
    // the predicate inspects. Express owns the body here, so always hand the
    // conversion a parsed body (`?? {}` — `express.json()` leaves `req.body`
    // undefined for a body it does not parse) rather than letting it read a
    // stream the legacy arm may still need. The predicate takes just the
    // request; a body Express could not parse as JSON does not classify as
    // legacy and falls through to the strict modern arm.
    const probe = await toWebRequest(req, req.body ?? {});
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
