/**
 * Sessionful 2025-era serving through the dual-era HTTP entry's
 * bring-your-own legacy slot, exercised on the wire() entryStateless arm with
 * the slot overridden via `wire()`'s `entry.legacy` option.
 *
 * The legacy slot value is a real sessionful wiring — one
 * WebStandardStreamableHTTPServerTransport per session, kept in a map keyed by
 * the Mcp-Session-Id the transport itself issues (the documented sessionful
 * hosting pattern) — and a plain 2025 SDK client drives the full session
 * lifecycle through the harness-hosted `createMcpHandler`: initialize issues a
 * session id, a follow-up POST is served on that session, the body-less GET
 * opens the standalone SSE stream, and DELETE tears the session down. Every
 * exchange the slot serves is recorded as it leaves the wiring (method, status,
 * content-type), so the entry's routing of GET/DELETE (no envelope, no body →
 * legacy slot) to the bring-your-own handler is pinned directly; byte-level
 * forwarding fidelity is not asserted here.
 */
import { randomUUID } from 'node:crypto';

import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Client } from '@modelcontextprotocol/client';
import type { LegacyHttpHandler, McpHandlerRequestOptions, McpRequestContext } from '@modelcontextprotocol/server';
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { expect, vi } from 'vitest';
import { z } from 'zod/v4';

import { wire } from '../helpers/index.js';
import { verifies } from '../helpers/verifies.js';
import type { TestArgs } from '../types.js';

const LEGACY = '2025-11-25';

/** The factory backing the modern path; this cell never drives it (the lifecycle under test is the legacy slot's). */
function modernFactory(_ctx?: McpRequestContext): McpServer {
    const server = new McpServer({ name: 'e2e-entry-session', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.registerTool('greet', { inputSchema: z.object({ name: z.string() }) }, ({ name }) => ({
        content: [{ type: 'text', text: `hello ${name} (modern)` }]
    }));
    return server;
}

verifies('typescript:hosting:entry:byo-sessionful-legacy', async ({ transport }: TestArgs) => {
    // The documented sessionful wiring, passed as the bring-your-own legacy
    // slot value: a fresh transport per initialize, kept in a map keyed by the
    // Mcp-Session-Id it issues; later requests are routed by that header.
    const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
    const closedSessions: string[] = [];
    const sessionServers: McpServer[] = [];

    async function routeSessionRequest(request: Request, options?: McpHandlerRequestOptions): Promise<Response> {
        const sessionId = request.headers.get('mcp-session-id');
        if (sessionId !== null) {
            const existing = sessions.get(sessionId);
            if (existing !== undefined) return existing.handleRequest(request, options);
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
        const server = new McpServer({ name: 'byo-session-server', version: '1.0.0' }, { capabilities: { tools: {} } });
        server.registerTool('greet', { inputSchema: z.object({ name: z.string() }) }, ({ name }) => ({
            content: [{ type: 'text', text: `hello ${name} (byo session)` }]
        }));
        sessionServers.push(server);
        await server.connect(transport);
        return transport.handleRequest(request, options);
    }

    // Every exchange the entry forwards to the bring-your-own slot, recorded
    // as it leaves the wiring: this is what proves the GET/DELETE routing.
    const slotExchanges: Array<{ method: string; status: number; contentType: string }> = [];
    const sessionfulLegacy: LegacyHttpHandler = async (request, options) => {
        const response = await routeSessionRequest(request, options);
        slotExchanges.push({
            method: request.method.toUpperCase(),
            status: response.status,
            contentType: response.headers.get('content-type') ?? ''
        });
        return response;
    };

    const client = new Client({ name: 'plain-2025-client', version: '1.0.0' });
    try {
        // The harness hosts the entry; the bring-your-own wiring replaces the
        // arm's default 'stateless' slot value.
        await using wired = await wire(transport, modernFactory, client, { entry: { legacy: sessionfulLegacy } });

        // initialize → the bring-your-own transport issues an Mcp-Session-Id.
        // (The stateless slot never issues one, so a defined session id alone
        // proves the request reached the bring-your-own wiring.)
        expect(client.getNegotiatedProtocolVersion()).toBe(LEGACY);
        const clientTransport = client.transport as StreamableHTTPClientTransport;
        const sessionId = clientTransport.sessionId;
        expect(sessionId).toBeDefined();
        expect(sessions.has(sessionId!)).toBe(true);

        // Follow-up POST on the session: served by the same per-session instance.
        const result = await client.callTool({ name: 'greet', arguments: { name: 'session friend' } });
        expect(result.content).toEqual([{ type: 'text', text: 'hello session friend (byo session)' }]);
        expect(clientTransport.sessionId).toBe(sessionId);

        // GET route: the client opens its standalone SSE stream after
        // initialization; the entry routes the body-less GET (no envelope) to
        // the legacy slot, which answers it with the stream.
        await vi.waitFor(
            () => {
                const get = slotExchanges.find(exchange => exchange.method === 'GET');
                if (get === undefined) throw new Error('the standalone GET stream has not reached the legacy slot yet');
                expect(get.status).toBe(200);
                expect(get.contentType).toContain('text/event-stream');
            },
            { timeout: 5000, interval: 50 }
        );

        // DELETE route: terminating the session goes through the entry to the
        // bring-your-own transport, which tears the session down.
        await clientTransport.terminateSession();
        expect(closedSessions).toEqual([sessionId]);
        const deleteExchange = slotExchanges.find(exchange => exchange.method === 'DELETE');
        expect(deleteExchange?.status).toBe(200);

        // Stop the client before probing the dead session so its standalone
        // stream cannot reconnect underneath the assertion.
        await client.close();

        // The dead session is gone: a POST carrying its id is answered 404 by
        // the bring-your-own wiring, not silently re-served by anything else.
        const stale = await wired.fetch!(wired.url!, {
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
        // ...and that 404 was produced by the bring-your-own wiring (the probe
        // reached the slot), not synthesized by the entry or anything in front of it.
        expect(slotExchanges.some(exchange => exchange.method === 'POST' && exchange.status === 404)).toBe(true);
    } finally {
        await client.close().catch(() => {});
        for (const server of sessionServers) await server.close().catch(() => {});
    }
});
