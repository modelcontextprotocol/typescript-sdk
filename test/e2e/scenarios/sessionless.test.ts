/**
 * Self-contained test bodies for the sessionless invariants of the per-request
 * protocol revisions (SEP-2567, with SEP-2575's endpoint rules): the POST-only
 * endpoint (GET/DELETE → 405, batch → 400), the session-header ban on both
 * sides, per-request authorization context, list-result connection invariance
 * and side-effect freedom, the re-scoped request-id uniqueness, stdio
 * cancellation of in-flight stateless requests, and the absence of SSE
 * resumption ids on stateless response streams.
 *
 * The streamableHttp cells drive raw Request/Response against WebStandard
 * transports connected directly; the session-header pair drives a real
 * 2026-mode client through a recording/header-injecting fetch; the stdio
 * cancellation cell spawns the fixture server as a real child process.
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { CallToolResultSchema, JSONRPCResultResponseSchema } from '@modelcontextprotocol/core';
import type { AuthInfo, JSONRPCMessage, JSONRPCRequest } from '@modelcontextprotocol/server';
import {
    DRAFT_PROTOCOL_VERSION,
    McpServer,
    SUPPORTED_PROTOCOL_VERSIONS,
    WebStandardStreamableHTTPServerTransport
} from '@modelcontextprotocol/server';
import { expect, vi } from 'vitest';
import { z } from 'zod/v4';

import { verifies } from '../helpers/verifies.js';
import type { TestArgs } from '../types.js';

/** Absolute path to the runnable stdio fixture server (executed with tsx). */
const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/stdio-server.ts', import.meta.url));

/** E2E package root — spawn cwd so the workspace-local `tsx` resolves and tsconfig paths map workspace packages to source. */
const E2E_ROOT = fileURLToPath(new URL('../', import.meta.url));

const DRAFT_LISTED = [...SUPPORTED_PROTOCOL_VERSIONS, DRAFT_PROTOCOL_VERSION];

const baseHeaders = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream'
};

const draftHeaders = { ...baseHeaders, 'mcp-protocol-version': DRAFT_PROTOCOL_VERSION };

/** The complete per-request `_meta` envelope this protocol revision requires. */
const envelope = (overrides?: Record<string, unknown>) => ({
    'io.modelcontextprotocol/protocolVersion': DRAFT_PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientInfo': { name: 'sessionless-client', version: '9.9.9' },
    'io.modelcontextprotocol/clientCapabilities': {},
    ...overrides
});

/** An enveloped tools/call request. */
const toolCall = (id: number | string, name: string, args: Record<string, unknown> = {}): JSONRPCRequest => ({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args, _meta: envelope() }
});

const post = (tx: WebStandardStreamableHTTPServerTransport, body: unknown, headers: Record<string, string> = draftHeaders) =>
    tx.handleRequest(new Request('http://in-process/mcp', { method: 'POST', headers, body: JSON.stringify(body) }));

verifies(['hosting:sessionless:get-405', 'hosting:sessionless:delete-405', 'hosting:sessionless:no-batching'], async (_args: TestArgs) => {
    // One opted-in server behind a session-less WebStandard transport: the
    // endpoint discipline of the per-request revisions is POST-only with
    // exactly one JSON-RPC message per body.
    const server = new McpServer({ name: 's', version: '0' }, { supportedProtocolVersions: DRAFT_LISTED });
    server.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({
        content: [{ type: 'text', text }]
    }));
    const tx = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(tx);
    try {
        for (const method of ['GET', 'DELETE']) {
            const res = await tx.handleRequest(
                new Request('http://in-process/mcp', {
                    method,
                    headers: { accept: 'application/json, text/event-stream', 'mcp-protocol-version': DRAFT_PROTOCOL_VERSION }
                })
            );
            expect(res.status, method).toBe(405);
            expect(res.headers.get('allow'), method).toBe('POST');
            expect(res.headers.get('mcp-session-id'), method).toBeNull();
        }

        // A batch body — two individually well-formed, fully enveloped requests —
        // is rejected for being a batch, with the request ids unreadable by
        // construction (a batch has no single id): -32600, id null, HTTP 400.
        const batch = await post(tx, [toolCall(61, 'echo', { text: 'one' }), toolCall(62, 'echo', { text: 'two' })]);
        expect(batch.status).toBe(400);
        expect(await batch.json()).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32_600 } });

        // The same message outside the array is served — the rejection above is
        // about batching, not about the request contents.
        const single = await post(tx, toolCall(63, 'echo', { text: 'one' }));
        expect(single.status).toBe(200);
        expect(await single.json()).toMatchObject({ jsonrpc: '2.0', id: 63 });
    } finally {
        await tx.close();
    }
});

verifies(['hosting:sessionless:no-session-header', 'client-transport:http:no-session-header'], async (_args: TestArgs) => {
    // A dual-stack server WITH a sessionIdGenerator: the per-request path must
    // not engage it. The recording fetch captures every request's headers and
    // the server's raw response headers, then hands the client a tampered
    // response carrying an injected Mcp-Session-Id — which a 2026-mode client
    // must ignore entirely (no storage, no replay).
    const server = new McpServer({ name: 's', version: '0' }, { supportedProtocolVersions: DRAFT_LISTED });
    server.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({
        content: [{ type: 'text', text }]
    }));
    const tx = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    await server.connect(tx);

    const requestSessionHeaders: Array<string | null> = [];
    const rawResponseSessionHeaders: Array<string | null> = [];
    const fetchFn = async (url: URL | string, init?: RequestInit): Promise<Response> => {
        const request = new Request(url, init);
        requestSessionHeaders.push(request.headers.get('mcp-session-id'));
        const response = await tx.handleRequest(request);
        rawResponseSessionHeaders.push(response.headers.get('mcp-session-id'));
        const tampered = new Headers(response.headers);
        tampered.set('mcp-session-id', 'injected-by-test');
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers: tampered });
    };

    const client = new Client({ name: 'sessionless-client', version: '0.0.1' }, { supportedProtocolVersions: [DRAFT_PROTOCOL_VERSION] });
    const clientTx = new StreamableHTTPClientTransport(new URL('http://in-process/mcp'), { fetch: fetchFn });
    try {
        await client.connect(clientTx);
        await client.callTool({ name: 'echo', arguments: { text: 'one' } });
        // The injected header was seen by now; a further request proves no replay.
        await client.callTool({ name: 'echo', arguments: { text: 'two' } });

        expect(requestSessionHeaders.length).toBeGreaterThanOrEqual(3); // discover + two calls
        expect(requestSessionHeaders).toEqual(requestSessionHeaders.map(() => null));
        // The server side never emitted one either, sessionIdGenerator notwithstanding.
        expect(rawResponseSessionHeaders).toEqual(rawResponseSessionHeaders.map(() => null));
        expect(clientTx.sessionId).toBeUndefined();
    } finally {
        await client.close();
        await tx.close();
    }
});

verifies(['hosting:sessionless:per-request-auth', 'typescript:mcpserver:tool:extra-sessionless'], async (_args: TestArgs) => {
    const server = new McpServer({ name: 's', version: '0' }, { supportedProtocolVersions: DRAFT_LISTED });
    server.registerTool('report-extra', { inputSchema: z.object({}) }, (_a, ctx) => ({
        content: [
            {
                type: 'text',
                text: JSON.stringify({
                    sessionId: ctx.sessionId ?? null,
                    requestId: ctx.mcpReq.id,
                    hasSignal: ctx.mcpReq.signal instanceof AbortSignal,
                    hasNotify: typeof ctx.mcpReq.notify === 'function',
                    authInfo: ctx.http?.authInfo ? { token: ctx.http.authInfo.token, clientId: ctx.http.authInfo.clientId } : null
                })
            }
        ]
    }));
    const tx = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(tx);

    const reported = async (id: number, authInfo?: AuthInfo) => {
        const res = await tx.handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: draftHeaders,
                body: JSON.stringify(toolCall(id, 'report-extra'))
            }),
            authInfo ? { authInfo } : undefined
        );
        expect(res.status).toBe(200);
        const body = JSONRPCResultResponseSchema.parse(await res.json());
        expect(body.id).toBe(id);
        const content = CallToolResultSchema.parse(body.result).content;
        return JSON.parse((content[0] as { text: string }).text) as Record<string, unknown>;
    };

    try {
        // First request carries validated auth; the handler context exposes exactly it.
        const first = await reported(71, { token: 'token-71', clientId: 'client-71', scopes: ['mcp'] });
        expect(first).toEqual({
            sessionId: null,
            requestId: 71,
            hasSignal: true,
            hasNotify: true,
            authInfo: { token: 'token-71', clientId: 'client-71' }
        });

        // Second request on the SAME transport carries none — and sees none:
        // authorization context is per-request, never inherited.
        const second = await reported(72);
        expect(second).toEqual({ sessionId: null, requestId: 72, hasSignal: true, hasNotify: true, authInfo: null });
    } finally {
        await tx.close();
    }
});

verifies(
    ['protocol:stateless:list-connection-independent', 'protocol:stateless:list-no-side-effects', 'protocol:request-id:outstanding-scope'],
    async (_args: TestArgs) => {
        // Instance-per-request hosting: each transport serves a fresh server from
        // the same factory — two transports are two independent connections.
        const makeServer = () => {
            const s = new McpServer({ name: 's', version: '0' }, { supportedProtocolVersions: DRAFT_LISTED });
            s.registerTool('alpha', { description: 'first tool', inputSchema: z.object({}) }, () => ({
                content: [{ type: 'text', text: 'alpha' }]
            }));
            s.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({
                content: [{ type: 'text', text }]
            }));
            return s;
        };
        const connect = async () => {
            const tx = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            await makeServer().connect(tx);
            return tx;
        };
        const listTools = async (tx: WebStandardStreamableHTTPServerTransport, id: number) => {
            const res = await post(tx, { jsonrpc: '2.0', id, method: 'tools/list', params: { _meta: envelope() } });
            expect(res.status).toBe(200);
            const body = JSONRPCResultResponseSchema.parse(await res.json());
            expect(body.id).toBe(id);
            return (body.result as { tools: unknown[] }).tools;
        };

        const tx1 = await connect();
        const tx2 = await connect();
        try {
            // Connection invariance: the same list through two independent connections.
            const first = await listTools(tx1, 11);
            const onOtherConnection = await listTools(tx2, 11);
            expect(onOtherConnection).toEqual(first);

            // An intervening call on connection 1...
            const call = await post(tx1, toolCall(12, 'echo', { text: 'between lists' }));
            expect(call.status).toBe(200);

            // ...leaves the list unchanged — asked for with the SAME JSON-RPC id as
            // the first (already settled) list request: under the re-scoped
            // uniqueness rule a completed id may be reused, and the request is
            // served normally.
            const again = await listTools(tx1, 11);
            expect(again).toEqual(first);
        } finally {
            await tx1.close();
            await tx2.close();
        }
    }
);

verifies('protocol:stateless:stdio-cancellation', async (_args: TestArgs) => {
    // Real child process: the in-flight stateless request is cancelled via
    // notifications/cancelled, the handler observes its per-request signal
    // fire (reported on stderr — the only channel allowed to carry anything
    // for the request after cancellation), and no further stdout frame ever
    // appears for that id while unrelated traffic keeps flowing.
    const tx = new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', FIXTURE_PATH],
        cwd: E2E_ROOT,
        env: { E2E_LIST_DRAFT_VERSION: '1' },
        stderr: 'pipe'
    });
    const received: JSONRPCMessage[] = [];
    tx.onmessage = message => void received.push(message);
    let stderrText = '';
    try {
        await tx.start();
        tx.stderr?.on('data', chunk => {
            stderrText += String(chunk);
        });

        await tx.send(toolCall(77, 'slow'));
        // The tool signals it is running by emitting one progress notification.
        // Generous wait: tsx compiles the fixture inside the freshly spawned child first.
        await vi.waitFor(() => expect(received.some(m => 'method' in m && m.method === 'notifications/progress')).toBe(true), {
            timeout: 10_000,
            interval: 25
        });

        await tx.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 77 } });
        // The handler observed ctx.mcpReq.signal.aborted === true.
        await vi.waitFor(() => expect(stderrText).toContain('aborted:77:true'), { timeout: 5000, interval: 25 });

        // Unrelated traffic still round-trips on the same pipe — and because stdout
        // frames are ordered, this response arriving proves the (suppressed) late
        // frames of request 77 never made it out.
        await tx.send(toolCall(78, 'echo', { text: 'after-cancel' }));
        await vi.waitFor(() => expect(received.some(m => 'id' in m && m.id === 78)).toBe(true), { timeout: 5000, interval: 25 });
        expect(received.filter(m => 'id' in m && m.id === 77)).toEqual([]);
    } finally {
        await tx.close();
    }
});

verifies('hosting:http:stateless-no-sse-event-ids', async (_args: TestArgs) => {
    // The trap under test: an eventStore IS configured, so the 2025 session
    // path would offer resumption ids — the stateless path must not.
    const events: string[] = [];
    const server = new McpServer({ name: 's', version: '0' }, { supportedProtocolVersions: DRAFT_LISTED });
    server.registerTool('progressing', { inputSchema: z.object({}) }, async (_a, ctx) => {
        await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: 'tok', progress: 1 } });
        return { content: [{ type: 'text', text: 'streamed' }] };
    });
    const tx = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        eventStore: {
            storeEvent: async (streamId, _message) => {
                events.push(streamId);
                return `event-${events.length}`;
            },
            replayEventsAfter: async () => 'unused'
        }
    });
    await server.connect(tx);
    try {
        const res = await post(tx, toolCall('sse-1', 'progressing'));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('text/event-stream');

        const raw = await res.text();
        // The stream carried the notification and the response...
        expect(raw).toContain('notifications/progress');
        expect(raw).toContain('"sse-1"');
        // ...but not a single SSE id: line, and nothing was offered for replay.
        expect(raw).not.toMatch(/^id:/m);
        expect(events).toEqual([]);
    } finally {
        await tx.close();
    }
});
