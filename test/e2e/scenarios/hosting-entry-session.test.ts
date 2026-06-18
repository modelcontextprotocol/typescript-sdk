/**
 * Sessionful 2025-era serving kept alive next to a strict dual-era HTTP entry
 * through explicit user-land routing: the exported `isLegacyRequest` predicate
 * (the entry's own classification step) decides, an existing sessionful wiring
 * serves the legacy branch, and a strict (`legacy: 'reject'`) `createMcpHandler`
 * serves everything else. This is the documented replacement for the removed
 * handler-valued `legacy` option.
 *
 * The legacy wiring is real and sessionful — one
 * WebStandardStreamableHTTPServerTransport per session, kept in a map keyed by
 * the Mcp-Session-Id the transport itself issues (the documented sessionful
 * hosting pattern) — and a plain 2025 SDK client drives the full session
 * lifecycle through the routed composition: initialize issues a session id, a
 * follow-up POST is served on that session, the body-less GET opens the
 * standalone SSE stream, and DELETE tears the session down. Every exchange the
 * wiring serves is recorded as it leaves it (method, status, content-type), so
 * the predicate's routing of GET/DELETE (no envelope, no body → legacy) is
 * pinned directly; byte-level forwarding fidelity is not asserted here. An
 * envelope-claiming probe at the end pins that modern traffic is answered by
 * the strict entry, never by the legacy wiring.
 *
 * The composition is hosted by the test body itself (an in-process fetch in
 * front of both handlers), so the wire() entry arm is not used; the matrix
 * still bounds the cell to the 2025-11-25 axis via the requirement entry.
 */
import { randomUUID } from 'node:crypto';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { LegacyHttpHandler, McpRequestContext } from '@modelcontextprotocol/server';
import { createMcpHandler, isLegacyRequest, McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { expect, vi } from 'vitest';
import { z } from 'zod/v4';

import { modernEnvelopeMeta } from '../helpers/index.js';
import { verifies } from '../helpers/verifies.js';

const LEGACY = '2025-11-25';

/** The factory backing the strict modern entry; legacy traffic never reaches it (the lifecycle under test is the legacy wiring's). */
function modernFactory(_ctx?: McpRequestContext): McpServer {
    const server = new McpServer({ name: 'e2e-entry-session', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.registerTool('greet', { inputSchema: z.object({ name: z.string() }) }, ({ name }) => ({
        content: [{ type: 'text', text: `hello ${name} (modern)` }]
    }));
    return server;
}

verifies('typescript:hosting:entry:byo-sessionful-legacy', async () => {
    // The documented sessionful wiring, kept exactly as an existing deployment
    // would have it: a fresh transport per initialize, kept in a map keyed by
    // the Mcp-Session-Id it issues; later requests are routed by that header.
    const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
    const closedSessions: string[] = [];
    const sessionServers: McpServer[] = [];

    async function routeSessionRequest(request: Request): Promise<Response> {
        const sessionId = request.headers.get('mcp-session-id');
        if (sessionId !== null) {
            const existing = sessions.get(sessionId);
            if (existing !== undefined) return existing.handleRequest(request);
            // A request for a session this wiring no longer (or never) knew —
            // the documented sessionful pattern answers 404.
            return Response.json({ jsonrpc: '2.0', error: { code: -32_001, message: 'Session not found' }, id: null }, { status: 404 });
        }
        const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID,
            onsessioninitialized: id => void sessions.set(id, transport),
            onsessionclosed: id => {
                closedSessions.push(id);
                sessions.delete(id);
            }
        });
        const server = new McpServer({ name: 'sessionful-legacy-server', version: '1.0.0' }, { capabilities: { tools: {} } });
        server.registerTool('greet', { inputSchema: z.object({ name: z.string() }) }, ({ name }) => ({
            content: [{ type: 'text', text: `hello ${name} (legacy session)` }]
        }));
        sessionServers.push(server);
        await server.connect(transport);
        return transport.handleRequest(request);
    }

    // Every exchange routed to the existing legacy wiring, recorded as it
    // leaves the wiring: this is what proves the GET/DELETE routing.
    const legacyExchanges: Array<{ method: string; status: number; contentType: string }> = [];
    const sessionfulLegacy: LegacyHttpHandler = async request => {
        const response = await routeSessionRequest(request);
        legacyExchanges.push({
            method: request.method.toUpperCase(),
            status: response.status,
            contentType: response.headers.get('content-type') ?? ''
        });
        return response;
    };

    // The documented user-land routing pattern: a strict modern entry plus the
    // exported predicate in front of the existing legacy wiring.
    const modern = createMcpHandler(modernFactory, { legacy: 'reject' });
    const route = async (request: Request): Promise<Response> => {
        if (await isLegacyRequest(request)) {
            return sessionfulLegacy(request);
        }
        return modern.fetch(request);
    };
    const url = new URL('http://in-process/mcp');
    const fetchViaRouter = (input: URL | string, init?: RequestInit) => route(new Request(input, init));

    const client = new Client({ name: 'plain-2025-client', version: '1.0.0' });
    try {
        await client.connect(new StreamableHTTPClientTransport(url, { fetch: fetchViaRouter }));

        // initialize → the sessionful wiring issues an Mcp-Session-Id. (The
        // strict entry never issues one, so a defined session id alone proves
        // the request was routed to the existing legacy wiring.)
        expect(client.getNegotiatedProtocolVersion()).toBe(LEGACY);
        const clientTransport = client.transport as StreamableHTTPClientTransport;
        const sessionId = clientTransport.sessionId;
        expect(sessionId).toBeDefined();
        expect(sessions.has(sessionId!)).toBe(true);

        // Follow-up POST on the session: served by the same per-session instance.
        const result = await client.callTool({ name: 'greet', arguments: { name: 'session friend' } });
        expect(result.content).toEqual([{ type: 'text', text: 'hello session friend (legacy session)' }]);
        expect(clientTransport.sessionId).toBe(sessionId);

        // GET route: the client opens its standalone SSE stream after
        // initialization; the predicate routes the body-less GET (no envelope)
        // to the legacy wiring, which answers it with the stream.
        await vi.waitFor(
            () => {
                const get = legacyExchanges.find(exchange => exchange.method === 'GET');
                if (get === undefined) throw new Error('the standalone GET stream has not reached the legacy wiring yet');
                expect(get.status).toBe(200);
                expect(get.contentType).toContain('text/event-stream');
            },
            { timeout: 5000, interval: 50 }
        );

        // DELETE route: terminating the session goes through the predicate to
        // the sessionful wiring, which tears the session down.
        await clientTransport.terminateSession();
        expect(closedSessions).toEqual([sessionId]);
        const deleteExchange = legacyExchanges.find(exchange => exchange.method === 'DELETE');
        expect(deleteExchange?.status).toBe(200);

        // Stop the client before probing the dead session so its standalone
        // stream cannot reconnect underneath the assertion.
        await client.close();

        // The dead session is gone: a POST carrying its id is answered 404 by
        // the sessionful wiring, not silently re-served by anything else.
        const stale = await fetchViaRouter(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                'mcp-session-id': sessionId!,
                'mcp-protocol-version': LEGACY
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} })
        });
        expect(stale.status).toBe(404);
        await stale.text();
        // ...and that 404 was produced by the sessionful wiring (the probe
        // reached it), not synthesized by the entry or anything in front of it.
        expect(legacyExchanges.some(exchange => exchange.method === 'POST' && exchange.status === 404)).toBe(true);

        // Modern traffic is the strict entry's: an envelope-claiming request is
        // answered by the modern factory and never reaches the legacy wiring.
        const exchangesBeforeModernProbe = legacyExchanges.length;
        const modernProbe = await fetchViaRouter(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 100,
                method: 'tools/call',
                params: {
                    name: 'greet',
                    arguments: { name: 'router' },
                    _meta: modernEnvelopeMeta({ name: 'router-probe-client', version: '1.0.0' })
                }
            })
        });
        expect(modernProbe.status).toBe(200);
        expect(await modernProbe.text()).toContain('hello router (modern)');
        expect(legacyExchanges).toHaveLength(exchangesBeforeModernProbe);
    } finally {
        await client.close().catch(() => {});
        await modern.close().catch(() => {});
        for (const server of sessionServers) await server.close().catch(() => {});
    }
});
