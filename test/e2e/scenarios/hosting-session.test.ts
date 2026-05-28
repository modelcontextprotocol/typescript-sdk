/**
 * Self-contained test bodies for the hosting-session surface.
 *
 * These tests exercise HTTP server-side semantics: session management
 * (create/reuse/delete), CORS headers, stateless vs. stateful hosting,
 * and in-flight request cancellation. Most tests build the hosting layer
 * directly with `hostPerSession()` or `hostStateless()` from helpers and
 * drive it with raw HTTP (new Request(...)) to assert status codes and
 * headers.
 */

import { randomUUID } from 'node:crypto';

import cors from 'cors';
import express from 'express';
import { expect, vi } from 'vitest';
import { z } from 'zod/v4';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer, WebStandardStreamableHTTPServerTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startExpressMinimal } from '../helpers/express.js';
import { hostPerSession, hostStateless, wire } from '../helpers/index.js';
import type { TestArgs } from '../types.js';
import { verifies } from '../helpers/verifies.js';

const newClient = () => new Client({ name: 'c', version: '0' });

function echoServer(): McpServer {
    const s = new McpServer({ name: 's', version: '0' });
    s.registerTool(
        'echo',
        { description: 'Echoes the input text back as a text content block.', inputSchema: z.object({ text: z.string() }) },
        ({ text }) => ({ content: [{ type: 'text', text }] })
    );
    return s;
}

verifies('hosting:session:create', async (_args: TestArgs) => {
    const initializedSessions: string[] = [];
    const server = echoServer();
    const tx = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: id => void initializedSessions.push(id)
    });
    await server.connect(tx);
    const url = new URL('http://in-process/mcp');

    try {
        const res = await tx.handleRequest(
            new Request(url, {
                method: 'POST',
                headers: {
                    'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream'
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'initialize',
                    params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'c', version: '0' } }
                })
            })
        );
        expect(res.status).toBe(200);

        const sessionId = res.headers.get('mcp-session-id');
        if (sessionId === null) throw new Error('initialize response is missing the mcp-session-id header');
        expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        expect(initializedSessions).toEqual([sessionId]);
    } finally {
        await server.close();
    }
});

verifies('hosting:session:cors-expose', async (_args: TestArgs) => {
    const browserOrigin = 'http://dashboard.example.com';
    const servers: McpServer[] = [];

    // The transport sets no CORS headers itself; the documented hosting layer is cors() with exposedHeaders.
    const router = express.Router();
    router.use(cors({ origin: browserOrigin, exposedHeaders: ['Mcp-Session-Id'] }));
    router.post('/mcp', async (req, res) => {
        const tx = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
        const server = echoServer();
        await server.connect(tx);
        servers.push(server);
        await tx.handleRequest(req, res, req.body);
    });

    await using host = await startExpressMinimal(router);

    try {
        const res = await fetch(new URL('/mcp', host.baseUrl), {
            method: 'POST',
            headers: {
                origin: browserOrigin,
                'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream'
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'c', version: '0' } }
            })
        });

        expect(res.status).toBe(200);
        expect(res.headers.get('mcp-session-id')).not.toBeNull();
        expect(res.headers.get('access-control-allow-origin')).toBe(browserOrigin);

        const exposeHeaders = res.headers.get('access-control-expose-headers');
        if (exposeHeaders === null) throw new Error('initialize response is missing the access-control-expose-headers header');
        expect(exposeHeaders.toLowerCase()).toContain('mcp-session-id');

        await res.text();
    } finally {
        for (const server of servers) await server.close();
    }
});

verifies('hosting:session:reuse', async (_args: TestArgs) => {
    const host = hostPerSession(() => echoServer());
    const url = new URL('http://in-process/mcp');
    const fetch = (u: URL | string, init?: RequestInit) => host.handleRequest(new Request(u, init));

    const client = newClient();
    await client.connect(new StreamableHTTPClientTransport(url, { fetch }));

    const sessionId = (client.transport as StreamableHTTPClientTransport).sessionId;
    expect(sessionId).toBeDefined();
    expect(typeof sessionId).toBe('string');

    const r1 = await client.listTools();
    expect(r1.tools.map(t => t.name)).toContain('echo');

    const r2 = await client.callTool({ name: 'echo', arguments: { text: 'reuse-test' } });
    expect(r2.content).toEqual([{ type: 'text', text: 'reuse-test' }]);

    const stillSameSession = (client.transport as StreamableHTTPClientTransport).sessionId;
    expect(stillSameSession).toBe(sessionId);

    await client.close();
    await host.close();
});

verifies('hosting:session:unknown-id', async (_args: TestArgs) => {
    const { handleRequest, close } = hostPerSession(echoServer);
    try {
        const init = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'initialize',
                    params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'c', version: '0' } }
                })
            })
        );
        expect(init.status).toBe(200);

        const unknownId = randomUUID();
        const headers = {
            'mcp-session-id': unknownId,
            'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream'
        };
        const post = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers,
                body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
            })
        );
        expect(post.status).toBe(404);

        const get = await handleRequest(new Request('http://in-process/mcp', { method: 'GET', headers }));
        expect(get.status).toBe(404);

        const del = await handleRequest(new Request('http://in-process/mcp', { method: 'DELETE', headers }));
        expect(del.status).toBe(404);
    } finally {
        await close();
    }
});

verifies('hosting:session:missing-id', async (_args: TestArgs) => {
    // Initialize the transport first so the missing-header branch is hit, not the uninitialized-server branch.
    const server = echoServer();
    const tx = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    await server.connect(tx);
    const url = new URL('http://in-process/mcp');
    const headers = {
        'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
    };

    try {
        const initRes = await tx.handleRequest(
            new Request(url, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'initialize',
                    params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'c', version: '0' } }
                })
            })
        );
        expect(initRes.status).toBe(200);
        expect(initRes.headers.get('mcp-session-id')).not.toBeNull();

        const res = await tx.handleRequest(
            new Request(url, {
                method: 'POST',
                headers,
                body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
            })
        );
        expect(res.status).toBe(400);

        const body = (await res.json()) as { error?: { code?: number; message?: string } };
        expect(body.error?.code).toBe(-32000);
        expect(body.error?.message).toBe('Bad Request: Mcp-Session-Id header is required');
    } finally {
        await server.close();
    }
});

verifies('hosting:session:delete', async (_args: TestArgs) => {
    // hostPerSession owns its session callbacks, so build the per-session map inline to observe onsessionclosed.
    const closedSessions: string[] = [];
    const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
    const handle = async (req: Request): Promise<Response> => {
        const sid = req.headers.get('mcp-session-id');
        const existing = sid ? sessions.get(sid) : undefined;
        if (existing) return existing.handleRequest(req);

        const tx = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID,
            onsessioninitialized: id => void sessions.set(id, tx),
            onsessionclosed: id => {
                closedSessions.push(id);
                sessions.delete(id);
            }
        });
        await echoServer().connect(tx);
        return tx.handleRequest(req);
    };

    const url = new URL('http://in-process/mcp');
    const headers = {
        'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
    };

    try {
        const initRes = await handle(
            new Request(url, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'initialize',
                    params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'c', version: '0' } }
                })
            })
        );
        expect(initRes.status).toBe(200);
        const sessionId = initRes.headers.get('mcp-session-id');
        if (sessionId === null) throw new Error('initialize response is missing the mcp-session-id header');
        expect(Array.from(sessions.keys())).toEqual([sessionId]);

        const listRes = await handle(
            new Request(url, {
                method: 'POST',
                headers: { ...headers, 'mcp-session-id': sessionId },
                body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
            })
        );
        expect(listRes.status).toBe(200);
        expect(closedSessions).toEqual([]);

        const deleteRes = await handle(
            new Request(url, {
                method: 'DELETE',
                headers: { 'mcp-protocol-version': LATEST_PROTOCOL_VERSION, 'mcp-session-id': sessionId }
            })
        );
        expect(deleteRes.status).toBe(200);
        expect(closedSessions).toEqual([sessionId]);
        expect(sessions.size).toBe(0);

        // The old id no longer routes to a live transport once onsessionclosed removed it from the map.
        const reuseRes = await handle(
            new Request(url, {
                method: 'POST',
                headers: { ...headers, 'mcp-session-id': sessionId },
                body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })
            })
        );
        expect(reuseRes.status).toBeGreaterThanOrEqual(400);
    } finally {
        for (const tx of sessions.values()) await tx.close();
    }
});

verifies('hosting:session:post-termination-404', async (_args: TestArgs) => {
    // The documented per-session hosting pattern is the layer that owns session lifetime, so termination is asserted through it.
    const { handleRequest, close } = hostPerSession(echoServer);
    const url = new URL('http://in-process/mcp');
    const headers = {
        'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
    };

    try {
        const initRes = await handleRequest(
            new Request(url, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'initialize',
                    params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'c', version: '0' } }
                })
            })
        );
        expect(initRes.status).toBe(200);
        const sessionId = initRes.headers.get('mcp-session-id');
        if (sessionId === null) throw new Error('initialize response is missing the mcp-session-id header');

        // The session answers a request before termination, so any later 404 is attributable to the DELETE alone.
        const liveRes = await handleRequest(
            new Request(url, {
                method: 'POST',
                headers: { ...headers, 'mcp-session-id': sessionId },
                body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
            })
        );
        expect(liveRes.status).toBe(200);

        const deleteRes = await handleRequest(
            new Request(url, {
                method: 'DELETE',
                headers: { 'mcp-protocol-version': LATEST_PROTOCOL_VERSION, 'mcp-session-id': sessionId }
            })
        );
        expect(deleteRes.status).toBe(200);

        const staleHeaders = { ...headers, 'mcp-session-id': sessionId };
        const stalePost = await handleRequest(
            new Request(url, {
                method: 'POST',
                headers: staleHeaders,
                body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })
            })
        );
        expect(stalePost.status).toBe(404);

        const staleGet = await handleRequest(new Request(url, { method: 'GET', headers: staleHeaders }));
        expect(staleGet.status).toBe(404);

        const staleDelete = await handleRequest(new Request(url, { method: 'DELETE', headers: staleHeaders }));
        expect(staleDelete.status).toBe(404);
    } finally {
        await close();
    }
});

verifies('hosting:session:id-charset', async (_args: TestArgs) => {
    // The SDK has no default generator; its contract is emitting the configured generator's value verbatim in the header.
    const generatedIds = ['!session-0x21-low-boundary', '~session-0x7E-high-boundary', randomUUID()];
    const url = new URL('http://in-process/mcp');

    for (const generatedId of generatedIds) {
        const server = echoServer();
        const tx = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => generatedId });
        await server.connect(tx);

        try {
            const res = await tx.handleRequest(
                new Request(url, {
                    method: 'POST',
                    headers: {
                        'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
                        'content-type': 'application/json',
                        accept: 'application/json, text/event-stream'
                    },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        id: 1,
                        method: 'initialize',
                        params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'c', version: '0' } }
                    })
                })
            );
            expect(res.status).toBe(200);

            const headerValue = res.headers.get('mcp-session-id');
            if (headerValue === null) throw new Error('initialize response is missing the mcp-session-id header');
            expect(headerValue).toBe(generatedId);

            for (const ch of headerValue) {
                const code = ch.charCodeAt(0);
                expect(code).toBeGreaterThanOrEqual(0x21);
                expect(code).toBeLessThanOrEqual(0x7e);
            }
        } finally {
            await server.close();
        }
    }
});

verifies('hosting:session:reinitialize', async (_args: TestArgs) => {
    const host = hostPerSession(() => echoServer());
    const url = new URL('http://in-process/mcp');

    const initReq = new Request(url, {
        method: 'POST',
        headers: {
            'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream'
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'c', version: '0' } }
        })
    });

    const initRes = await host.handleRequest(initReq);
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get('mcp-session-id');
    expect(sessionId).toBeDefined();

    const reinitReq = new Request(url, {
        method: 'POST',
        headers: {
            'mcp-session-id': sessionId!,
            'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream'
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'initialize',
            params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'c', version: '0' } }
        })
    });

    const reinitRes = await host.handleRequest(reinitReq);
    expect(reinitRes.status).toBe(400);

    await host.close();
});

verifies('hosting:session:isolation', async (_args: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        let visits = 0;
        s.registerTool(
            'record_visit',
            { description: 'Increments and returns the visit counter for this session.', inputSchema: z.object({}) },
            () => {
                visits += 1;
                return { content: [{ type: 'text', text: `visits:${visits}` }] };
            }
        );
        return s;
    };

    const host = hostPerSession(makeServer);
    const url = new URL('http://in-process/mcp');
    const fetch = (u: URL | string, init?: RequestInit) => host.handleRequest(new Request(u, init));

    const clientA = newClient();
    const txA = new StreamableHTTPClientTransport(url, { fetch });
    await clientA.connect(txA);

    const clientB = newClient();
    const txB = new StreamableHTTPClientTransport(url, { fetch });
    await clientB.connect(txB);

    const sessionIdA = txA.sessionId;
    const sessionIdB = txB.sessionId;
    if (sessionIdA === undefined || sessionIdB === undefined) throw new Error('initialize did not assign a session id');
    expect(sessionIdA).not.toBe(sessionIdB);

    try {
        const a1 = await clientA.callTool({ name: 'record_visit', arguments: {} });
        expect(a1.content).toEqual([{ type: 'text', text: 'visits:1' }]);
        const a2 = await clientA.callTool({ name: 'record_visit', arguments: {} });
        expect(a2.content).toEqual([{ type: 'text', text: 'visits:2' }]);

        // B starts at 1: counter state accumulated in A's McpServer instance never leaks into B's.
        const b1 = await clientB.callTool({ name: 'record_visit', arguments: {} });
        expect(b1.content).toEqual([{ type: 'text', text: 'visits:1' }]);

        await clientB.close();

        const deleteRes = await host.handleRequest(
            new Request(url, {
                method: 'DELETE',
                headers: { 'mcp-protocol-version': LATEST_PROTOCOL_VERSION, 'mcp-session-id': sessionIdB }
            })
        );
        expect(deleteRes.status).toBe(200);

        const a3 = await clientA.callTool({ name: 'record_visit', arguments: {} });
        expect(a3.content).toEqual([{ type: 'text', text: 'visits:3' }]);

        const reuseRes = await host.handleRequest(
            new Request(url, {
                method: 'POST',
                headers: {
                    'mcp-session-id': sessionIdB,
                    'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream'
                },
                body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} })
            })
        );
        expect(reuseRes.status).toBeGreaterThanOrEqual(400);
    } finally {
        await clientA.close();
        await host.close();
    }
});

verifies('hosting:stateless:no-session-id', async (_args: TestArgs) => {
    const host = hostStateless(() => echoServer());
    const url = new URL('http://in-process/mcp');

    const req = new Request(url, {
        method: 'POST',
        headers: {
            'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream'
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'c', version: '0' } }
        })
    });

    const res = await host.handleRequest(req);
    expect(res.status).toBe(200);

    const sessionId = res.headers.get('mcp-session-id');
    expect(sessionId).toBeNull();

    await host.close();
});

verifies('hosting:stateless:concurrent-clients', async (_args: TestArgs) => {
    const host = hostStateless(() => echoServer());
    const url = new URL('http://in-process/mcp');
    const fetch = (u: URL | string, init?: RequestInit) => host.handleRequest(new Request(u, init));

    const clients = [
        new Client({ name: 'c1', version: '0' }),
        new Client({ name: 'c2', version: '0' }),
        new Client({ name: 'c3', version: '0' })
    ];

    await Promise.all(clients.map(c => c.connect(new StreamableHTTPClientTransport(url, { fetch }))));

    const [r1, r2, r3] = await Promise.all([
        clients[0].callTool({ name: 'echo', arguments: { text: 'client-1' } }),
        clients[1].callTool({ name: 'echo', arguments: { text: 'client-2' } }),
        clients[2].callTool({ name: 'echo', arguments: { text: 'client-3' } })
    ]);

    expect(r1.content).toEqual([{ type: 'text', text: 'client-1' }]);
    expect(r2.content).toEqual([{ type: 'text', text: 'client-2' }]);
    expect(r3.content).toEqual([{ type: 'text', text: 'client-3' }]);

    await Promise.all(clients.map(c => c.close()));
    await host.close();
});

verifies('hosting:stateless:get-delete-405', async (_args: TestArgs) => {
    const url = new URL('http://in-process/mcp');
    // hostStateless hand-rolls a 405 for non-POST before the SDK runs; hit the SDK transport directly so its own behavior is asserted.
    const handleStateless = async (req: Request): Promise<Response> => {
        const server = echoServer();
        const tx = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await server.connect(tx);
        try {
            return await tx.handleRequest(req);
        } finally {
            await server.close();
        }
    };

    const getRes = await handleStateless(
        new Request(url, {
            method: 'GET',
            headers: { 'mcp-protocol-version': LATEST_PROTOCOL_VERSION, accept: 'text/event-stream' }
        })
    );
    expect(getRes.status).toBe(405);

    const deleteRes = await handleStateless(
        new Request(url, { method: 'DELETE', headers: { 'mcp-protocol-version': LATEST_PROTOCOL_VERSION } })
    );
    expect(deleteRes.status).toBe(405);
});

verifies('hosting:stateless:progress-in-post-stream', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('progress-tool', { inputSchema: z.object({ steps: z.number() }) }, async ({ steps }, ctx) => {
            const token = ctx.mcpReq._meta?.progressToken;
            if (token !== undefined) {
                for (let i = 1; i <= steps; i++) {
                    await ctx.mcpReq.notify({
                        method: 'notifications/progress',
                        params: { progressToken: token, progress: i, total: steps }
                    });
                }
            }
            return { content: [{ type: 'text', text: 'done' }] };
        });
        return s;
    };

    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const progressEvents: Array<{ progress: number; total?: number }> = [];
    let receivedAtResolve = -1;

    const result = await client
        .callTool({ name: 'progress-tool', arguments: { steps: 3 } }, undefined, {
            onprogress: p => progressEvents.push({ progress: p.progress, total: p.total })
        })
        .then(res => {
            receivedAtResolve = progressEvents.length;
            return res;
        });

    expect(receivedAtResolve).toBe(3);
    expect(progressEvents).toEqual([
        { progress: 1, total: 3 },
        { progress: 2, total: 3 },
        { progress: 3, total: 3 }
    ]);
    expect(result.content).toEqual([{ type: 'text', text: 'done' }]);
});

verifies('hosting:stateless:no-reuse', async (_args: TestArgs) => {
    // Build the transport directly: hostStateless creates a fresh transport per request, which would never hit the reuse guard.
    const server = echoServer();
    const tx = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(tx);
    const url = new URL('http://in-process/mcp');

    try {
        const initRes = await tx.handleRequest(
            new Request(url, {
                method: 'POST',
                headers: {
                    'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream'
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'initialize',
                    params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'c', version: '0' } }
                })
            })
        );
        expect(initRes.status).toBe(200);

        const secondReq = new Request(url, {
            method: 'POST',
            headers: {
                'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream'
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
        });

        await expect(tx.handleRequest(secondReq)).rejects.toThrow(/cannot be reused across requests/);
    } finally {
        await server.close();
        await tx.close();
    }
});

verifies('transport:streamable-http:stateless-restrictions', async (_args: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool(
            'needs-sampling',
            { description: 'Asks the client LLM to draft a one-line status update.', inputSchema: z.object({}) },
            async () => {
                try {
                    const draft = await s.server.createMessage({
                        messages: [{ role: 'user', content: { type: 'text', text: 'Draft a one-line status update.' } }],
                        maxTokens: 50
                    });
                    return { content: [{ type: 'text', text: JSON.stringify(draft.content) }] };
                } catch (err) {
                    return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
                }
            }
        );
        return s;
    };

    const host = hostStateless(makeServer);
    const url = new URL('http://in-process/mcp');
    const client = new Client({ name: 'c', version: '0' }, { capabilities: { sampling: {} } });
    // A real sampling handler proves any failure comes from the stateless hosting gap, not a missing client capability.
    client.setRequestHandler('sampling/createMessage', async () => ({
        model: 'mock-model',
        role: 'assistant',
        content: { type: 'text', text: 'A drafted status update.' }
    }));

    try {
        await client.connect(new StreamableHTTPClientTransport(url, { fetch: (u, init) => host.handleRequest(new Request(u, init)) }));

        let timer: NodeJS.Timeout | undefined;
        const settled = client.callTool({ name: 'needs-sampling', arguments: {} }).then(
            value => ({ kind: 'resolved' as const, value }),
            (reason: unknown) => ({ kind: 'rejected' as const, reason })
        );
        const outcome = await Promise.race([
            settled,
            new Promise<{ kind: 'pending' }>(resolve => {
                timer = setTimeout(() => resolve({ kind: 'pending' }), 1500);
            })
        ]);
        clearTimeout(timer);

        if (outcome.kind === 'pending') {
            throw new Error('tools/call never settled: server.createMessage() hangs in stateless mode instead of rejecting promptly');
        }
        if (outcome.kind === 'rejected') {
            throw new Error(`tools/call rejected instead of returning an isError result: ${String(outcome.reason)}`);
        }

        const result = outcome.value;
        expect(result.isError).toBe(true);
        if (!Array.isArray(result.content)) throw new Error('tools/call result has no content array');
        expect(result.content).toHaveLength(1);
        const block: unknown = result.content[0];
        if (
            typeof block !== 'object' ||
            block === null ||
            !('type' in block) ||
            block.type !== 'text' ||
            !('text' in block) ||
            typeof block.text !== 'string'
        ) {
            throw new Error('tools/call error content is not a single text block');
        }
        expect(block.text.length).toBeGreaterThan(0);
        expect(block.text).not.toMatch(/does not support sampling|method not found/i);
    } finally {
        await client.close();
        await host.close();
    }
});

verifies('hosting:session:delete-cancels-inflight', async (_args: TestArgs) => {
    const started: string[] = [];
    const aborted: string[] = [];

    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        // Resolves only when its abort signal fires, so the call stays in flight until DELETE cancels it.
        s.registerTool(
            'index_repository',
            { description: 'Indexes a source repository for code search.', inputSchema: z.object({ repository: z.string() }) },
            ({ repository }, ctx) =>
                new Promise(resolve => {
                    started.push(repository);
                    ctx.mcpReq.signal.addEventListener('abort', () => {
                        aborted.push(repository);
                        resolve({ content: [{ type: 'text', text: `${repository} indexing interrupted` }] });
                    });
                })
        );
        return s;
    };

    const host = hostPerSession(makeServer);
    const url = new URL('http://in-process/mcp');
    const headers = {
        'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
    };

    try {
        const initRes = await host.handleRequest(
            new Request(url, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'initialize',
                    params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'c', version: '0' } }
                })
            })
        );
        expect(initRes.status).toBe(200);
        const sessionId = initRes.headers.get('mcp-session-id');
        expect(sessionId).toBeDefined();

        const callRequest = (id: number, repository: string) =>
            host.handleRequest(
                new Request(url, {
                    method: 'POST',
                    headers: { ...headers, 'mcp-session-id': sessionId! },
                    body: JSON.stringify({
                        jsonrpc: '2.0',
                        id,
                        method: 'tools/call',
                        params: { name: 'index_repository', arguments: { repository } }
                    })
                })
            );

        const firstCall = await callRequest(2, 'docs-site');
        const secondCall = await callRequest(3, 'billing-service');
        expect(firstCall.status).toBe(200);
        expect(secondCall.status).toBe(200);
        expect(firstCall.headers.get('content-type')).toMatch(/text\/event-stream/);
        expect(secondCall.headers.get('content-type')).toMatch(/text\/event-stream/);

        await vi.waitFor(() => expect([...started].sort()).toEqual(['billing-service', 'docs-site']));
        expect(aborted).toEqual([]);

        const deleteRes = await host.handleRequest(
            new Request(url, {
                method: 'DELETE',
                headers: { 'mcp-protocol-version': LATEST_PROTOCOL_VERSION, 'mcp-session-id': sessionId! }
            })
        );
        expect(deleteRes.status).toBe(200);

        await vi.waitFor(() => expect([...aborted].sort()).toEqual(['billing-service', 'docs-site']));

        // text() resolves only once the server ends the stream; no data event means no JSON-RPC response was written.
        const bodies = await Promise.all([firstCall.text(), secondCall.text()]);
        for (const body of bodies) {
            expect(body.split('\n').filter(line => line.startsWith('data:'))).toEqual([]);
        }
    } finally {
        await host.close();
    }
});
