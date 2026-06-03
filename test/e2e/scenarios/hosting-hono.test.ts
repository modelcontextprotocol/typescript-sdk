/**
 * Self-contained test bodies for the Hono hosting adapter (@modelcontextprotocol/hono).
 *
 * These tests cover createMcpHonoApp() over real HTTP: the app is served with
 * @hono/node-server on an ephemeral 127.0.0.1 port, WebStandardStreamableHTTPServerTransport
 * instances are mounted on the /mcp routes (the documented Hono hosting pattern), and a
 * StreamableHTTPClientTransport (or raw HTTP for hostile-Host probes) drives it from outside.
 * The hosting adapter is the subject, so the matrix transport arg is ignored and every
 * listener, transport, and server is closed in finally.
 */

import { randomUUID } from 'node:crypto';
import http from 'node:http';

import { serve } from '@hono/node-server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import type { Hono } from 'hono';
import { expect } from 'vitest';
import { z } from 'zod/v4';

import { verifies } from '../helpers/verifies.js';
import type { TestArgs } from '../types.js';

function recipeServer(): McpServer {
    const s = new McpServer({ name: 'recipe-server', version: '1.2.0' });
    s.registerTool(
        'get_recipe',
        { description: 'Returns the preparation steps for a named dish.', inputSchema: z.object({ dish: z.string() }) },
        ({ dish }) => ({ content: [{ type: 'text', text: `Steps for ${dish}: mix, bake, serve.` }] })
    );
    return s;
}

/**
 * Mount per-session WebStandard streamable HTTP transports on the app's /mcp routes,
 * mirroring the documented Hono hosting pattern (handlers pass c.req.raw to the transport).
 */
function mountMcp(app: Hono, makeServer: () => McpServer): { close(): Promise<void> } {
    const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
    const servers: McpServer[] = [];
    const bySession = (sessionId: string | undefined) => (sessionId === undefined ? undefined : sessions.get(sessionId));

    app.post('/mcp', async c => {
        const existing = bySession(c.req.header('mcp-session-id'));
        if (existing) return existing.handleRequest(c.req.raw);
        const tx = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID,
            onsessioninitialized: id => void sessions.set(id, tx),
            onsessionclosed: id => void sessions.delete(id)
        });
        const server = makeServer();
        servers.push(server);
        await server.connect(tx);
        return tx.handleRequest(c.req.raw);
    });
    app.get('/mcp', async c => {
        const existing = bySession(c.req.header('mcp-session-id'));
        if (existing) return existing.handleRequest(c.req.raw);
        return c.json({ jsonrpc: '2.0', error: { code: -32_000, message: 'Bad Request: No valid session ID provided' }, id: null }, 400);
    });
    app.delete('/mcp', async c => {
        const existing = bySession(c.req.header('mcp-session-id'));
        if (existing) return existing.handleRequest(c.req.raw);
        return c.json({ jsonrpc: '2.0', error: { code: -32_000, message: 'Bad Request: No valid session ID provided' }, id: null }, 400);
    });

    return {
        close: async () => {
            for (const server of servers) await server.close();
            for (const tx of sessions.values()) await tx.close();
            sessions.clear();
        }
    };
}

/** Serve a Hono app on an ephemeral 127.0.0.1 port via @hono/node-server, resolving once it is listening. */
function listenHono(app: Hono): Promise<{ baseUrl: URL; close(): Promise<void> }> {
    return new Promise(resolve => {
        const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, info => {
            resolve({
                baseUrl: new URL(`http://127.0.0.1:${info.port}`),
                close: () =>
                    new Promise<void>((res, rej) => {
                        server.close(err => (err ? rej(err) : res()));
                    })
            });
        });
    });
}

/**
 * POST `body` to `url` via `node:http`, forcing `Host: <host>`.
 * Unlike undici fetch(), node:http sends caller-supplied Host headers verbatim.
 */
function postWithHost(url: URL, host: string, body: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                hostname: url.hostname,
                port: url.port,
                path: url.pathname,
                method: 'POST',
                headers: {
                    Host: host,
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                    'Content-Length': Buffer.byteLength(body)
                }
            },
            res => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', chunk => (data += chunk));
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
                res.on('error', reject);
            }
        );
        req.on('error', reject);
        req.end(body);
    });
}

verifies('hosting:hono:basic-flow', async (_args: TestArgs) => {
    const app = createMcpHonoApp();
    const mounted = mountMcp(app, recipeServer);
    const listener = await listenHono(app);
    const client = new Client({ name: 'hono-e2e-client', version: '0.1.0' });
    const clientTransport = new StreamableHTTPClientTransport(new URL('/mcp', listener.baseUrl));

    try {
        await client.connect(clientTransport);

        expect(client.getServerVersion()).toEqual({ name: 'recipe-server', version: '1.2.0' });
        expect(clientTransport.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

        const { tools } = await client.listTools();
        expect(tools.map(t => ({ name: t.name, description: t.description }))).toEqual([
            { name: 'get_recipe', description: 'Returns the preparation steps for a named dish.' }
        ]);

        const result = await client.callTool({ name: 'get_recipe', arguments: { dish: 'shakshuka' } });
        expect(result.content).toEqual([{ type: 'text', text: 'Steps for shakshuka: mix, bake, serve.' }]);
    } finally {
        await client.close();
        await mounted.close();
        await listener.close();
    }
});

verifies('hosting:hono:host-header-validation', async (_args: TestArgs) => {
    let serversBuilt = 0;
    const app = createMcpHonoApp();
    const mounted = mountMcp(app, () => {
        serversBuilt += 1;
        return recipeServer();
    });
    const listener = await listenHono(app);
    const client = new Client({ name: 'hono-e2e-client', version: '0.1.0' });

    try {
        const rejected = await postWithHost(
            new URL('/mcp', listener.baseUrl),
            'evil.example.com',
            JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'rebinding-probe', version: '0.0.1' } }
            })
        );
        expect(rejected.status).toBe(403);
        expect(JSON.parse(rejected.body)).toEqual({
            jsonrpc: '2.0',
            error: { code: -32_000, message: 'Invalid Host: evil.example.com' },
            id: null
        });
        // Rejected before reaching the MCP layer: no server was ever constructed for the hostile request.
        expect(serversBuilt).toBe(0);

        // Control: the same endpoint accepts a client whose requests carry the localhost Host header (127.0.0.1).
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', listener.baseUrl)));

        const { tools } = await client.listTools();
        expect(tools.map(t => t.name)).toEqual(['get_recipe']);
        expect(serversBuilt).toBe(1);
    } finally {
        await client.close();
        await mounted.close();
        await listener.close();
    }
});
