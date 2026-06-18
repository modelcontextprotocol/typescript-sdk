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

import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { McpRequestContext } from '@modelcontextprotocol/server';
import { createMcpHandler, isLegacyRequest, McpServer } from '@modelcontextprotocol/server';
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
const ensureSessionful = async (sid: string | undefined) => {
    if (sid && sessions.has(sid)) return sessions.get(sid)!;
    const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: id => {
            sessions.set(id, transport);
        }
    });
    transport.onclose = () => transport.sessionId && sessions.delete(transport.sessionId);
    await buildServer('legacy').connect(transport);
    return transport;
};

// --- the strict modern entry alongside it ---
const modern = createMcpHandler((ctx: McpRequestContext) => buildServer(ctx.era), { legacy: 'reject' });

const app = createMcpExpressApp();
app.all('/', async (req: Request, res: Response) => {
    // The predicate inspects the same headers + body the entry does. Express
    // has parsed the JSON body; pass it as `parsedBody` so the predicate need
    // not re-read the stream.
    const probe = new globalThis.Request(`http://localhost${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>
    });
    if (await isLegacyRequest(probe, req.body)) {
        const sid = req.headers['mcp-session-id'] as string | undefined;
        const transport = await ensureSessionful(sid);
        await transport.handleRequest(req, res, req.body);
    } else {
        await modern.node(req, res, req.body);
    }
});

const argv = process.argv.slice(2);
const portIdx = argv.indexOf('--port');
const port = portIdx === -1 ? 3000 : Number(argv[portIdx + 1]);
app.listen(port, () => {
    console.error(`legacy-routing example server listening on http://127.0.0.1:${port}/`);
});
