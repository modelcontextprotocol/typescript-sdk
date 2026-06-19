/**
 * Standalone GET stream + `notifications/resources/list_changed` (sessionful
 * 2025).
 *
 * One `NodeStreamableHTTPServerTransport` + `McpServer` per session, the way
 * you would deploy a sessionful 2025 server. The `add_resource` tool registers
 * a new resource on the session's instance — `McpServer.registerResource` emits
 * `notifications/resources/list_changed`, which on a sessionful transport
 * travels over the **standalone GET** SSE stream the client opened. The client
 * decides when to mutate (no timer race in the harness).
 *
 * **HTTP-only**, sessionful 2025 by definition.
 */
import { randomUUID } from 'node:crypto';

import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { isInitializeRequest, McpServer } from '@modelcontextprotocol/server';
import type { Request, Response } from 'express';
import * as z from 'zod/v4';

const buildServer = () => {
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
};

const sessions = new Map<string, NodeStreamableHTTPServerTransport>();
const app = createMcpExpressApp();

app.post('/mcp', async (req: Request, res: Response) => {
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
    const t = sid ? sessions.get(sid) : undefined;
    if (!t) {
        res.status(sid ? 404 : 400).send(sid ? 'Session not found' : 'Missing session ID');
        return;
    }
    await t.handleRequest(req, res);
};
app.get('/mcp', sessionVerb);
app.delete('/mcp', sessionVerb);

const argv = process.argv.slice(2);
const portIdx = argv.indexOf('--port');
const port = portIdx === -1 ? Number(process.env.PORT ?? 3000) : Number(argv[portIdx + 1]);
app.listen(port, () => console.error(`standalone-get example server listening on http://127.0.0.1:${port}/mcp`));
