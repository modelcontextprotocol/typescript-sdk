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

import { Client } from '../../../src/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '../../../src/client/streamableHttp.js';
import { McpServer } from '../../../src/server/mcp.js';
import { StreamableHTTPServerTransport } from '../../../src/server/streamableHttp.js';
import { WebStandardStreamableHTTPServerTransport } from '../../../src/server/webStandardStreamableHttp.js';
import { CreateMessageRequestSchema, ElicitRequestSchema, LATEST_PROTOCOL_VERSION, ListRootsRequestSchema } from '../../../src/types.js';

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
        const tx = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
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
    // A per-session counter makes routing observable as state, and a second (decoy) session makes
    // BY-HEADER routing distinguishable from route-to-the-only/latest-transport.
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

    const client = newClient();
    const decoy = newClient();
    try {
        await client.connect(new StreamableHTTPClientTransport(url, { fetch }));

        const sessionId = (client.transport as StreamableHTTPClientTransport).sessionId;
        expect(sessionId).toBeDefined();
        expect(typeof sessionId).toBe('string');

        const r1 = await client.listTools();
        expect(r1.tools.map(t => t.name)).toContain('record_visit');
        const v1 = await client.callTool({ name: 'record_visit', arguments: {} });
        expect(v1.content).toEqual([{ type: 'text', text: 'visits:1' }]);

        // The decoy session is created AFTER the first call and never calls the tool: a host that
        // ignored the Mcp-Session-Id header and used the newest transport would reach the decoy's
        // fresh server instance (visits:1), not this session's accumulated state.
        await decoy.connect(new StreamableHTTPClientTransport(url, { fetch }));

        const v2 = await client.callTool({ name: 'record_visit', arguments: {} });
        expect(v2.content).toEqual([{ type: 'text', text: 'visits:2' }]);

        const stillSameSession = (client.transport as StreamableHTTPClientTransport).sessionId;
        expect(stillSameSession).toBe(sessionId);
    } finally {
        await client.close();
        await decoy.close();
        await host.close();
    }
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

verifies('typescript:consumer:session-expiry-message', async (_args: TestArgs) => {
    // The per-session host rejects unrecognized session ids with HTTP 400 and a body containing
    // 'No valid session ID' (the documented hosting pattern). Consumers regex-match that string
    // on the client-side error message and read the HTTP status off .code to detect session
    // expiry, so the client must surface both through the rejection.
    const host = hostPerSession(() => echoServer());
    const url = new URL('http://in-process/mcp');
    const fetch = (u: URL | string, init?: RequestInit) => host.handleRequest(new Request(u, init));

    const client = newClient();
    try {
        await client.connect(new StreamableHTTPClientTransport(url, { fetch }));
        await client.listTools();

        // Drop every server-side session while the client still holds its session id.
        await host.close();

        const err = await client.listTools().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(StreamableHTTPError);
        expect(err).toMatchObject({ code: 400 });
        expect((err as Error).message).toMatch(/No valid session ID/i);
    } finally {
        await client.close();
        await host.close();
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

verifies(
    'hosting:session:id-charset',
    async (_args: TestArgs) => {
        // The spec makes 0x21-0x7E a MUST for Mcp-Session-Id: a generator value violating it (a space
        // is 0x20) must not be emitted verbatim. A conforming transport either refuses the session or
        // emits a sanitized, charset-clean id.
        const server = echoServer();
        const tx = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => 'bad session id' });
        await server.connect(tx);

        try {
            const res = await tx.handleRequest(
                new Request('http://in-process/mcp', {
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

            const headerValue = res.headers.get('mcp-session-id');
            if (res.status === 200 && headerValue !== null) {
                for (const ch of headerValue) {
                    const code = ch.charCodeAt(0);
                    expect(code).toBeGreaterThanOrEqual(0x21);
                    expect(code).toBeLessThanOrEqual(0x7e);
                }
            } else {
                expect(res.status).toBeGreaterThanOrEqual(400);
            }
        } finally {
            await server.close();
        }
    },
    { title: 'non-conformant generator' }
);

verifies('hosting:session:reinitialize', async (_args: TestArgs) => {
    // Drive the transport directly: through the per-session host a header-less initialize routes to
    // a NEW transport by design and would never reach the already-initialized one, but the
    // requirement is unconditional — ANY second initialize reaching it is rejected.
    const server = echoServer();
    const tx = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    await server.connect(tx);
    const url = new URL('http://in-process/mcp');
    const headers = {
        'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
    };
    const initBody = (id: number) =>
        JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'initialize',
            params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'c', version: '0' } }
        });

    try {
        const initRes = await tx.handleRequest(new Request(url, { method: 'POST', headers, body: initBody(1) }));
        expect(initRes.status).toBe(200);
        const sessionId = initRes.headers.get('mcp-session-id');
        if (sessionId === null) throw new Error('initialize response is missing the mcp-session-id header');

        // Rejected with the session header present…
        const withHeader = await tx.handleRequest(
            new Request(url, { method: 'POST', headers: { ...headers, 'mcp-session-id': sessionId }, body: initBody(2) })
        );
        expect(withHeader.status).toBe(400);
        expect(await withHeader.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32600 } });

        // …and equally without it.
        const withoutHeader = await tx.handleRequest(new Request(url, { method: 'POST', headers, body: initBody(3) }));
        expect(withoutHeader.status).toBe(400);
        expect(await withoutHeader.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32600 } });

        // The original session survives both rejections.
        const live = await tx.handleRequest(
            new Request(url, {
                method: 'POST',
                headers: { ...headers, 'mcp-session-id': sessionId },
                body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} })
            })
        );
        expect(live.status).toBe(200);
        await live.body?.cancel();
    } finally {
        await server.close();
    }
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

        // Close-oldest direction: the requirement is symmetric over sessions, so deleting the FIRST
        // session must leave a newer one serving (an eviction bug keyed on creation order — e.g.
        // tearing down every session created after the closed one — escapes the close-newest arm).
        const clientC = newClient();
        const txC = new StreamableHTTPClientTransport(url, { fetch });
        await clientC.connect(txC);
        try {
            const c1 = await clientC.callTool({ name: 'record_visit', arguments: {} });
            expect(c1.content).toEqual([{ type: 'text', text: 'visits:1' }]);

            const deleteA = await host.handleRequest(
                new Request(url, {
                    method: 'DELETE',
                    headers: { 'mcp-protocol-version': LATEST_PROTOCOL_VERSION, 'mcp-session-id': sessionIdA }
                })
            );
            expect(deleteA.status).toBe(200);

            const reuseA = await host.handleRequest(
                new Request(url, {
                    method: 'POST',
                    headers: {
                        'mcp-session-id': sessionIdA,
                        'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
                        'content-type': 'application/json',
                        accept: 'application/json, text/event-stream'
                    },
                    body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'tools/list', params: {} })
                })
            );
            expect(reuseA.status).toBeGreaterThanOrEqual(400);

            const c2 = await clientC.callTool({ name: 'record_visit', arguments: {} });
            expect(c2.content).toEqual([{ type: 'text', text: 'visits:2' }]);
        } finally {
            await clientC.close();
        }
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

    // Conjunct (B) of the behavior: no session VALIDATION either — a non-initialize request
    // carrying an Mcp-Session-Id the server never issued is served normally, not rejected.
    const bogus = await host.handleRequest(
        new Request(url, {
            method: 'POST',
            headers: {
                'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
                'mcp-session-id': 'bogus-id-never-issued',
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream'
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
        })
    );
    expect(bogus.status).toBe(200);
    expect(bogus.headers.get('mcp-session-id')).toBeNull();
    // text() resolves when the server ends the POST SSE stream after writing the response.
    const data = (await bogus.text())
        .split('\n')
        .filter(l => l.startsWith('data: '))
        .map(l => JSON.parse(l.slice(6)) as Record<string, unknown>);
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ jsonrpc: '2.0', id: 2, result: {} });

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

// hostStateless hand-rolls a 405 for non-POST before the SDK runs; hit the SDK transport directly so its own behavior is asserted.
// One body per verb: packing both asserts into one test.fails body leaves the second verb dead code (the first assert fails
// first), so a partial SDK fix could never flip the cell.
const handleStatelessVerb = async (req: Request): Promise<Response> => {
    const server = echoServer();
    const tx = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(tx);
    try {
        return await tx.handleRequest(req);
    } finally {
        await server.close();
    }
};

verifies(
    'hosting:stateless:get-delete-405',
    async (_args: TestArgs) => {
        const getRes = await handleStatelessVerb(
            new Request('http://in-process/mcp', {
                method: 'GET',
                headers: { 'mcp-protocol-version': LATEST_PROTOCOL_VERSION, accept: 'text/event-stream' }
            })
        );
        expect(getRes.status).toBe(405);
    },
    { title: 'get' }
);

verifies(
    'hosting:stateless:get-delete-405',
    async (_args: TestArgs) => {
        const deleteRes = await handleStatelessVerb(
            new Request('http://in-process/mcp', { method: 'DELETE', headers: { 'mcp-protocol-version': LATEST_PROTOCOL_VERSION } })
        );
        expect(deleteRes.status).toBe(405);
    },
    { title: 'delete' }
);

verifies('hosting:stateless:progress-in-post-stream', async ({ transport, protocolVersion }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('progress-tool', { inputSchema: z.object({ steps: z.number() }) }, async ({ steps }, extra) => {
            const token = extra._meta?.progressToken;
            if (token !== undefined) {
                for (let i = 1; i <= steps; i++) {
                    await extra.sendNotification({
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
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

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
    const url = new URL('http://in-process/mcp');
    const headers = {
        'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
    };
    const usedOnce = async () => {
        const server = echoServer();
        const tx = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await server.connect(tx);
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
        await initRes.body?.cancel();
        return { server, tx };
    };

    // The guard covers ANY second call on the same instance — a POSTed JSON-RPC request, a POSTed
    // notification, and a GET — each probed against its own once-used transport.
    const requestProbe = await usedOnce();
    try {
        const secondReq = new Request(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
        });
        await expect(requestProbe.tx.handleRequest(secondReq)).rejects.toThrow(/cannot be reused across requests/);
    } finally {
        await requestProbe.server.close();
        await requestProbe.tx.close();
    }

    const notificationProbe = await usedOnce();
    try {
        const secondNotification = new Request(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
        });
        await expect(notificationProbe.tx.handleRequest(secondNotification)).rejects.toThrow(/cannot be reused across requests/);
    } finally {
        await notificationProbe.server.close();
        await notificationProbe.tx.close();
    }

    const getProbe = await usedOnce();
    try {
        const secondGet = new Request(url, { method: 'GET', headers: { accept: 'text/event-stream' } });
        await expect(getProbe.tx.handleRequest(secondGet)).rejects.toThrow(/cannot be reused across requests/);
    } finally {
        await getProbe.server.close();
        await getProbe.tx.close();
    }
});

/**
 * Drives one server-initiated request kind under stateless hosting: the named tool's handler
 * issues the request, the tools/call is raced against a settle timeout, and the call must return
 * an isError result promptly — neither hang nor reject. When `capabilityErrorPattern` is given,
 * the error text additionally must not be a capability complaint (the client registers a real
 * handler for the kind, so a capability-flavored failure would be the wrong fail-fast).
 */
async function expectStatelessFailFast(
    makeServer: () => McpServer,
    client: Client,
    toolName: string,
    requestDescription: string,
    capabilityErrorPattern?: RegExp
): Promise<void> {
    const host = hostStateless(makeServer);
    const url = new URL('http://in-process/mcp');

    try {
        await client.connect(new StreamableHTTPClientTransport(url, { fetch: (u, init) => host.handleRequest(new Request(u, init)) }));

        let timer: NodeJS.Timeout | undefined;
        const settled = client.callTool({ name: toolName, arguments: {} }).then(
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
            throw new Error(`tools/call never settled: ${requestDescription} hangs in stateless mode instead of rejecting promptly`);
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
        if (capabilityErrorPattern !== undefined) {
            expect(block.text).not.toMatch(capabilityErrorPattern);
        }
    } finally {
        await client.close();
        await host.close();
    }
}

verifies(
    'transport:streamable-http:stateless-restrictions',
    async (_args: TestArgs) => {
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

        const client = new Client({ name: 'c', version: '0' }, { capabilities: { sampling: {} } });
        // A real sampling handler proves any failure comes from the stateless hosting gap, not a missing client capability.
        client.setRequestHandler(CreateMessageRequestSchema, async () => ({
            model: 'mock-model',
            role: 'assistant',
            content: { type: 'text', text: 'A drafted status update.' }
        }));

        await expectStatelessFailFast(
            makeServer,
            client,
            'needs-sampling',
            'server.createMessage()',
            /does not support sampling|method not found/i
        );
    },
    { title: 'sampling' }
);

verifies(
    'transport:streamable-http:stateless-restrictions',
    async (_args: TestArgs) => {
        const makeServer = () => {
            const s = new McpServer({ name: 's', version: '0' });
            s.registerTool(
                'needs-elicitation',
                { description: 'Asks the user to confirm before proceeding.', inputSchema: z.object({}) },
                async () => {
                    try {
                        const answer = await s.server.elicitInput({
                            message: 'Proceed with the operation?',
                            requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] }
                        });
                        return { content: [{ type: 'text', text: JSON.stringify(answer) }] };
                    } catch (err) {
                        return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
                    }
                }
            );
            return s;
        };

        const client = new Client({ name: 'c', version: '0' }, { capabilities: { elicitation: {} } });
        client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'accept' as const, content: { confirm: true } }));

        // Unlike the sampling and roots kinds (which hang — see knownFailures), this kind already
        // fails fast at tip: elicitInput gates on the recorded client capabilities
        // (src/server/index.ts elicitInput), and under stateless hosting the per-request server
        // instance can never have them. No error-text pattern is asserted — the lock is the prompt
        // isError result itself, which is what the requirement demands.
        await expectStatelessFailFast(makeServer, client, 'needs-elicitation', 'server.elicitInput()');
    },
    { title: 'elicitation' }
);

verifies(
    'transport:streamable-http:stateless-restrictions',
    async (_args: TestArgs) => {
        const makeServer = () => {
            const s = new McpServer({ name: 's', version: '0' });
            s.registerTool(
                'needs-roots',
                { description: 'Lists the workspace roots exposed by the client.', inputSchema: z.object({}) },
                async () => {
                    try {
                        const roots = await s.server.listRoots();
                        return { content: [{ type: 'text', text: JSON.stringify(roots.roots) }] };
                    } catch (err) {
                        return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
                    }
                }
            );
            return s;
        };

        const client = new Client({ name: 'c', version: '0' }, { capabilities: { roots: {} } });
        // A real roots handler proves any failure comes from the stateless hosting gap, not a missing client capability.
        client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: 'file:///workspace', name: 'workspace' }] }));

        await expectStatelessFailFast(makeServer, client, 'needs-roots', 'server.listRoots()', /does not support roots|method not found/i);
    },
    { title: 'roots' }
);

verifies('hosting:session:delete-cancels-inflight', async (_args: TestArgs) => {
    const started: string[] = [];
    const aborted: string[] = [];

    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        // Resolves only when its abort signal fires, so the call stays in flight until DELETE cancels it.
        s.registerTool(
            'index_repository',
            { description: 'Indexes a source repository for code search.', inputSchema: z.object({ repository: z.string() }) },
            ({ repository }, extra) =>
                new Promise(resolve => {
                    started.push(repository);
                    extra.signal.addEventListener('abort', () => {
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

verifies('hosting:session:lifecycle-callbacks', async (_args: TestArgs) => {
    // Hosts use these two callbacks to maintain a session-id -> transport map, so the test routes through one.
    const initializedSessions: string[] = [];
    const closedSessions: string[] = [];
    const sessions = new Map<string, StreamableHTTPServerTransport>();

    const router = express.Router();
    router.all('/mcp', async (req, res) => {
        const sid = req.headers['mcp-session-id'];
        const existing = typeof sid === 'string' ? sessions.get(sid) : undefined;
        if (existing) {
            await existing.handleRequest(req, res, req.body);
            return;
        }
        const tx = new StreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID,
            onsessioninitialized: id => {
                initializedSessions.push(id);
                sessions.set(id, tx);
            },
            onsessionclosed: id => {
                closedSessions.push(id);
                sessions.delete(id);
            }
        });
        await echoServer().connect(tx);
        await tx.handleRequest(req, res, req.body);
    });

    await using host = await startExpressMinimal(router);
    const client = newClient();
    const clientTx = new StreamableHTTPClientTransport(new URL('/mcp', host.baseUrl));

    try {
        await client.connect(clientTx);

        const sessionId = clientTx.sessionId;
        if (sessionId === undefined) throw new Error('initialize did not assign a session id');
        expect(initializedSessions).toEqual([sessionId]);
        expect(closedSessions).toEqual([]);
        expect(Array.from(sessions.keys())).toEqual([sessionId]);

        // The map populated by onsessioninitialized routes the follow-up call back to the same transport.
        const result = await client.callTool({ name: 'echo', arguments: { text: 'lifecycle' } });
        expect(result.content).toEqual([{ type: 'text', text: 'lifecycle' }]);
        expect(initializedSessions).toEqual([sessionId]);
        expect(closedSessions).toEqual([]);

        await clientTx.terminateSession();
        expect(closedSessions).toEqual([sessionId]);
        expect(sessions.size).toBe(0);
    } finally {
        for (const tx of sessions.values()) await tx.close();
        await client.close();
    }
});
