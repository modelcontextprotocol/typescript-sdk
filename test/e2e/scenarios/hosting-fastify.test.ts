/**
 * Self-contained test bodies for the Fastify hosting adapter (@modelcontextprotocol/fastify).
 *
 * These tests cover createMcpFastifyApp() over real HTTP: the Fastify instance listens on an
 * ephemeral 127.0.0.1 port, per-session WebStandardStreamableHTTPServerTransport instances are
 * mounted on its /mcp routes via a small Node-to-web-standard Request adapter (Fastify parses
 * JSON bodies natively), and a StreamableHTTPClientTransport (or raw HTTP for hostile-Host
 * probes) drives it from outside. The hosting adapter is the subject, so the matrix transport
 * arg is ignored and every listener, transport, and server is closed in finally.
 */

import { randomUUID } from 'node:crypto';
import http from 'node:http';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpFastifyApp } from '@modelcontextprotocol/fastify';
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { expect } from 'vitest';
import { z } from 'zod/v4';

import { verifies } from '../helpers/verifies';
import type { TestArgs } from '../types';

function forecastServer(): McpServer {
    const s = new McpServer({ name: 'forecast-server', version: '0.3.0' });
    s.registerTool(
        'get_forecast',
        { description: 'Returns tomorrow’s weather forecast for a city.', inputSchema: z.object({ city: z.string() }) },
        ({ city }) => ({ content: [{ type: 'text', text: `Forecast for ${city}: sunny, high of 22C.` }] })
    );
    return s;
}

/** Adapt Fastify's request (Node IncomingMessage plus natively parsed JSON body) to the web-standard Request the transport consumes. */
function toWebRequest(request: FastifyRequest): Request {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
        // content-length is dropped because the body below is re-serialized from Fastify's parsed JSON
        if (name === 'content-length') continue;
        if (typeof value === 'string') headers.set(name, value);
        else if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    }
    return new Request(new URL(request.url, `http://${request.headers.host ?? '127.0.0.1'}`), {
        method: request.method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body)
    });
}

/**
 * Mount per-session WebStandard streamable HTTP transports on the app's /mcp routes,
 * handing each raw Fastify request to the transport and replying with the web-standard Response.
 */
function mountMcp(app: FastifyInstance, makeServer: () => McpServer): { close(): Promise<void> } {
    const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
    const servers: McpServer[] = [];
    const bySession = (request: FastifyRequest): WebStandardStreamableHTTPServerTransport | undefined => {
        const sessionId = request.headers['mcp-session-id'];
        return typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
    };

    app.post('/mcp', async (request, reply) => {
        const existing = bySession(request);
        if (existing) return reply.send(await existing.handleRequest(toWebRequest(request)));
        const tx = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID,
            onsessioninitialized: id => void sessions.set(id, tx),
            onsessionclosed: id => void sessions.delete(id)
        });
        const server = makeServer();
        servers.push(server);
        await server.connect(tx);
        return reply.send(await tx.handleRequest(toWebRequest(request)));
    });
    app.get('/mcp', async (request, reply) => {
        const existing = bySession(request);
        if (existing) return reply.send(await existing.handleRequest(toWebRequest(request)));
        return reply
            .code(400)
            .send({ jsonrpc: '2.0', error: { code: -32_000, message: 'Bad Request: No valid session ID provided' }, id: null });
    });
    app.delete('/mcp', async (request, reply) => {
        const existing = bySession(request);
        if (existing) return reply.send(await existing.handleRequest(toWebRequest(request)));
        return reply
            .code(400)
            .send({ jsonrpc: '2.0', error: { code: -32_000, message: 'Bad Request: No valid session ID provided' }, id: null });
    });

    return {
        close: async () => {
            for (const server of servers) await server.close();
            for (const tx of sessions.values()) await tx.close();
            sessions.clear();
        }
    };
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

verifies('hosting:fastify:basic-flow', async (_args: TestArgs) => {
    const app = createMcpFastifyApp();
    const mounted = mountMcp(app, forecastServer);
    const client = new Client({ name: 'fastify-e2e-client', version: '0.1.0' });

    try {
        const baseUrl = new URL(await app.listen({ port: 0, host: '127.0.0.1' }));
        const clientTransport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl));
        await client.connect(clientTransport);

        expect(client.getServerVersion()).toEqual({ name: 'forecast-server', version: '0.3.0' });
        expect(clientTransport.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

        const { tools } = await client.listTools();
        expect(tools.map(t => ({ name: t.name, description: t.description }))).toEqual([
            { name: 'get_forecast', description: 'Returns tomorrow’s weather forecast for a city.' }
        ]);

        const result = await client.callTool({ name: 'get_forecast', arguments: { city: 'Lisbon' } });
        expect(result.content).toEqual([{ type: 'text', text: 'Forecast for Lisbon: sunny, high of 22C.' }]);
    } finally {
        await client.close();
        await mounted.close();
        await app.close();
    }
});

verifies('hosting:fastify:host-header-validation', async ({ protocolVersion }: TestArgs) => {
    let serversBuilt = 0;
    const app = createMcpFastifyApp();
    const mounted = mountMcp(app, () => {
        serversBuilt += 1;
        return forecastServer();
    });
    const client = new Client({ name: 'fastify-e2e-client', version: '0.1.0' });

    try {
        const baseUrl = new URL(await app.listen({ port: 0, host: '127.0.0.1' }));

        const rejected = await postWithHost(
            new URL('/mcp', baseUrl),
            'evil.example.com',
            JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: { protocolVersion, capabilities: {}, clientInfo: { name: 'rebinding-probe', version: '0.0.1' } }
            })
        );
        expect(rejected.status).toBe(403);
        expect(JSON.parse(rejected.body)).toEqual({
            jsonrpc: '2.0',
            error: { code: -32_000, message: 'Invalid Host: evil.example.com' },
            id: null
        });
        // Rejected by the onRequest hook before reaching the MCP layer: no server was ever constructed for the hostile request.
        expect(serversBuilt).toBe(0);

        // Control: the same endpoint accepts a client whose requests carry the localhost Host header (127.0.0.1).
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', baseUrl)));

        const { tools } = await client.listTools();
        expect(tools.map(t => t.name)).toEqual(['get_forecast']);
        expect(serversBuilt).toBe(1);
    } finally {
        await client.close();
        await mounted.close();
        await app.close();
    }
});
