/**
 * Self-contained test bodies for hosting:http requirements.
 *
 * These pin the WebStandard server transport's HTTP/SSE semantics — the wire
 * surface ANY client implementation depends on — so they drive raw Request/Response rather than our Client.
 *
 * These tests cover WebStandardStreamableHTTPServerTransport behavior: HTTP
 * semantics (status codes, headers, content negotiation), SSE mechanics,
 * DNS-rebinding protection, and JSON response mode. Most tests make raw
 * Request/Response assertions against the handler returned by
 * hostPerSession() or hostStateless() from helpers/index.ts.
 */

import { randomUUID } from 'node:crypto';

import { expect, vi } from 'vitest';
import { z } from 'zod/v4';

import { McpServer } from '../../../src/server/mcp.js';
import {
    WebStandardStreamableHTTPServerTransport,
    type EventId,
    type EventStore,
    type StreamId
} from '../../../src/server/webStandardStreamableHttp.js';
import { LATEST_PROTOCOL_VERSION, type JSONRPCMessage } from '../../../src/types.js';

import { hostPerSession, hostStateless, type HttpHandler } from '../helpers/index.js';
import type { TestArgs } from '../types.js';
import { verifies } from '../helpers/verifies.js';

function echoServer(): McpServer {
    const s = new McpServer({ name: 's', version: '0' });
    s.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({
        content: [{ type: 'text', text }]
    }));
    return s;
}

const initializeBody = (clientInfo = { name: 'probe', version: '0' }) =>
    JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo }
    });

function sseTap(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let pending: ReturnType<typeof reader.read> | null = null;
    return {
        // Re-awaits the same in-flight read after a timeout so no chunk is ever dropped.
        async poll(timeoutMs: number): Promise<JSONRPCMessage[]> {
            pending ??= reader.read();
            const result = await Promise.race([pending, new Promise<null>(resolve => setTimeout(resolve, timeoutMs, null))]);
            if (result === null) return [];
            pending = null;
            if (result.done || !result.value) return [];
            buf += decoder.decode(result.value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop()!;
            return lines.filter(l => l.startsWith('data: ')).map((l): JSONRPCMessage => JSON.parse(l.slice(6)));
        },
        cancel: (): Promise<void> => reader.cancel()
    };
}

async function readAllSseMessages(body: ReadableStream<Uint8Array>): Promise<JSONRPCMessage[]> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
    }
    return buf
        .split('\n')
        .filter(l => l.startsWith('data: '))
        .map((l): JSONRPCMessage => JSON.parse(l.slice(6)));
}

verifies('hosting:http:accept-406', async (_args: TestArgs) => {
    const { handleRequest, close } = hostPerSession(echoServer);

    try {
        const base = { 'mcp-protocol-version': LATEST_PROTOCOL_VERSION };
        const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

        const initRes = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: { ...base, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
                body: initializeBody()
            })
        );
        expect(initRes.status).toBe(200);
        const sessionId = initRes.headers.get('mcp-session-id');
        expect(sessionId).toBeTruthy();
        const sessionHeaders = { ...base, 'mcp-session-id': sessionId! };

        const getWrongAccept = await handleRequest(
            new Request('http://in-process/mcp', { method: 'GET', headers: { ...sessionHeaders, accept: 'application/json' } })
        );
        expect(getWrongAccept.status).toBe(406);

        const getNoAccept = await handleRequest(new Request('http://in-process/mcp', { method: 'GET', headers: sessionHeaders }));
        expect(getNoAccept.status).toBe(406);

        const postJsonOnly = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: { ...sessionHeaders, 'content-type': 'application/json', accept: 'application/json' },
                body
            })
        );
        expect(postJsonOnly.status).toBe(406);

        const postSseOnly = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: { ...sessionHeaders, 'content-type': 'application/json', accept: 'text/event-stream' },
                body
            })
        );
        expect(postSseOnly.status).toBe(406);

        const postNoAccept = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: { ...sessionHeaders, 'content-type': 'application/json' },
                body
            })
        );
        expect(postNoAccept.status).toBe(406);
    } finally {
        await close();
    }
});

verifies('hosting:http:batch', async (_args: TestArgs) => {
    const { handleRequest, close } = hostStateless(echoServer);

    try {
        const headers = {
            'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream'
        };

        const single = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
        const singleRes = await handleRequest(new Request('http://in-process/mcp', { method: 'POST', headers, body: single }));
        expect(singleRes.status).toBe(200);
        const singleMessages = await readAllSseMessages(singleRes.body!);
        expect(singleMessages).toHaveLength(1);
        expect(singleMessages[0]).toMatchObject({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'echo' }] } });

        const batch = JSON.stringify([
            { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
            { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
        ]);
        const batchRes = await handleRequest(new Request('http://in-process/mcp', { method: 'POST', headers, body: batch }));
        expect(batchRes.status).toBe(200);
        const batchMessages = await readAllSseMessages(batchRes.body!);
        expect(batchMessages).toHaveLength(2);
        expect(batchMessages).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    jsonrpc: '2.0',
                    id: 1,
                    result: expect.objectContaining({ tools: [expect.objectContaining({ name: 'echo' })] })
                }),
                expect.objectContaining({
                    jsonrpc: '2.0',
                    id: 2,
                    result: expect.objectContaining({ tools: [expect.objectContaining({ name: 'echo' })] })
                })
            ])
        );
    } finally {
        await close();
    }
});

verifies('hosting:http:content-type-415', async (_args: TestArgs) => {
    const { handleRequest, close } = hostStateless(echoServer);

    try {
        // The requirement is universal: every non-JSON Content-Type yields 415, including the
        // json-ish near-miss text/json and a missing header entirely.
        const rejected: Array<string | undefined> = ['text/plain', 'application/xml', 'multipart/form-data', 'text/json', undefined];
        for (const contentType of rejected) {
            const req = new Request('http://in-process/mcp', {
                method: 'POST',
                headers: {
                    'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
                    'content-type': contentType ?? 'application/json',
                    accept: 'application/json, text/event-stream'
                },
                body: initializeBody()
            });
            // A string body makes the runtime default the header, so the missing-header case removes it post-construction.
            if (contentType === undefined) {
                req.headers.delete('content-type');
                expect(req.headers.get('content-type')).toBeNull();
            }
            const res = await handleRequest(req);
            expect(res.status).toBe(415);
        }

        // Positive boundary control: a parameterized JSON content type is accepted, not 415'd.
        const charset = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: {
                    'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
                    'content-type': 'application/json; charset=utf-8',
                    accept: 'application/json, text/event-stream'
                },
                body: initializeBody()
            })
        );
        expect(charset.status).toBe(200);
        await charset.body?.cancel();
    } finally {
        await close();
    }
});

verifies('hosting:http:disconnect-not-cancel', async (_args: TestArgs) => {
    const completions: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
        release = resolve;
    });
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('slow', { inputSchema: z.object({}) }, async (_args, extra) => {
            await gate;
            completions.push(extra.signal.aborted ? 'aborted' : 'completed');
            return { content: [{ type: 'text', text: 'done' }] };
        });
        return s;
    };
    const { handleRequest, close } = hostPerSession(makeServer);

    try {
        const initRes = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: {
                    'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream'
                },
                body: initializeBody()
            })
        );
        const sessionId = initRes.headers.get('mcp-session-id');

        const res = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: {
                    'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
                    'mcp-session-id': sessionId!,
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream'
                },
                body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slow', arguments: {} } })
            })
        );
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);

        // Cancelling the SSE response body is the transport's only disconnect observable.
        await res.body!.cancel();

        release();
        await vi.waitFor(() => expect(completions).toEqual(['completed']));
    } finally {
        release();
        await close();
    }
});

verifies(
    'hosting:http:disconnect-not-cancel',
    async (_args: TestArgs) => {
        // Clause 2 of the behavior: the result of the dropped request remains retrievable. With an
        // eventStore configured, the POST stream opens with a priming event id; a client that drops
        // the connection resumes via GET + Last-Event-ID, and the response — produced after the
        // disconnect — is delivered on the resumed stream.
        class MiniEventStore implements EventStore {
            private events: Array<{ id: string; streamId: string; message: JSONRPCMessage }> = [];
            private seq = 0;

            async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
                const id = `${streamId}_${String(this.seq++).padStart(6, '0')}`;
                this.events.push({ id, streamId, message });
                return id;
            }

            async getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
                return this.events.find(e => e.id === eventId)?.streamId;
            }

            async replayEventsAfter(
                lastEventId: EventId,
                { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> }
            ): Promise<StreamId> {
                const idx = this.events.findIndex(e => e.id === lastEventId);
                if (idx < 0) return '';
                const streamId = this.events[idx].streamId;
                for (const e of this.events.slice(idx + 1)) {
                    if (e.streamId === streamId) await send(e.id, e.message);
                }
                return streamId;
            }
        }

        const completions: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        const server = new McpServer({ name: 's', version: '0' });
        server.registerTool('slow', { inputSchema: z.object({}) }, async (_args2, extra) => {
            await gate;
            completions.push(extra.signal.aborted ? 'aborted' : 'completed');
            return { content: [{ type: 'text', text: 'done' }] };
        });
        const tx = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, eventStore: new MiniEventStore() });
        await server.connect(tx);

        try {
            const initRes = await tx.handleRequest(
                new Request('http://in-process/mcp', {
                    method: 'POST',
                    headers: {
                        'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
                        'content-type': 'application/json',
                        accept: 'application/json, text/event-stream'
                    },
                    body: initializeBody()
                })
            );
            expect(initRes.status).toBe(200);
            const sessionId = initRes.headers.get('mcp-session-id')!;
            await initRes.body!.cancel();

            const post = await tx.handleRequest(
                new Request('http://in-process/mcp', {
                    method: 'POST',
                    headers: {
                        'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
                        'mcp-session-id': sessionId,
                        'content-type': 'application/json',
                        accept: 'application/json, text/event-stream'
                    },
                    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slow', arguments: {} } })
                })
            );
            expect(post.status).toBe(200);
            expect(post.headers.get('content-type')).toMatch(/text\/event-stream/);

            // Read only the priming frame to capture the resumption point, then drop the connection.
            const reader = post.body!.getReader();
            const decoder = new TextDecoder();
            let buf = '';
            while (!buf.includes('\n\n')) {
                const { value, done } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
            }
            const lastEventId = buf.match(/^id: (\S+)$/m)?.[1];
            if (lastEventId === undefined) throw new Error(`POST stream did not open with a priming event id: ${JSON.stringify(buf)}`);
            await reader.cancel();

            // Resume before the handler completes — the transport routes the eventual response to
            // the stream that took over the original request stream's id.
            const resumed = await tx.handleRequest(
                new Request('http://in-process/mcp', {
                    method: 'GET',
                    headers: {
                        accept: 'text/event-stream',
                        'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
                        'mcp-session-id': sessionId,
                        'last-event-id': lastEventId
                    }
                })
            );
            expect(resumed.status).toBe(200);
            expect(resumed.headers.get('content-type')).toMatch(/text\/event-stream/);

            release();
            const replayed = await readAllSseMessages(resumed.body!);

            expect(completions).toEqual(['completed']);
            expect(replayed).toHaveLength(1);
            expect(replayed[0]).toMatchObject({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'done' }] } });
        } finally {
            release();
            await server.close();
            await tx.close();
        }
    },
    { title: 'result retrievable via resumption' }
);

verifies('hosting:http:dns-rebinding', async (_args: TestArgs) => {
    const makeServer = () => echoServer();
    const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
    const handleRequest: HttpHandler = async req => {
        const sid = req.headers.get('mcp-session-id') ?? undefined;
        const existing = sid ? sessions.get(sid) : undefined;
        if (existing) return existing.handleRequest(req);

        const tx = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID,
            onsessioninitialized: id => void sessions.set(id, tx),
            onsessionclosed: id => void sessions.delete(id),
            enableDnsRebindingProtection: true,
            allowedHosts: ['localhost'],
            allowedOrigins: ['http://localhost']
        });
        await makeServer().connect(tx);
        return tx.handleRequest(req);
    };

    try {
        const headers = {
            'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream'
        };

        const badHost = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: { ...headers, host: 'localhost.evil.com' },
                body: initializeBody()
            })
        );
        expect(badHost.status).toBe(403);

        const badOrigin = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: { ...headers, host: 'localhost', origin: 'http://localhost.evil.com' },
                body: initializeBody()
            })
        );
        expect(badOrigin.status).toBe(403);

        const noOrigin = await handleRequest(
            new Request('http://in-process/mcp', { method: 'POST', headers: { ...headers, host: 'localhost' }, body: initializeBody() })
        );
        expect(noOrigin.status).toBe(200);
        const sessionId = noOrigin.headers.get('mcp-session-id');

        const badOriginGet = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'GET',
                headers: {
                    accept: 'text/event-stream',
                    host: 'localhost',
                    'mcp-session-id': sessionId!,
                    origin: 'http://localhost.evil.com'
                }
            })
        );
        expect(badOriginGet.status).toBe(403);

        // With allowedHosts configured, a request carrying NO Host header at all is rejected too —
        // a check rewritten to only validate PRESENT headers would let this through.
        const noHostReq = new Request('http://in-process/mcp', { method: 'POST', headers, body: initializeBody() });
        expect(noHostReq.headers.get('host')).toBeNull();
        const noHost = await handleRequest(noHostReq);
        expect(noHost.status).toBe(403);

        // The Origin check applies to every method on the endpoint, DELETE included.
        const badOriginDelete = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'DELETE',
                headers: { host: 'localhost', 'mcp-session-id': sessionId!, origin: 'http://localhost.evil.com' }
            })
        );
        expect(badOriginDelete.status).toBe(403);
    } finally {
        for (const t of Array.from(sessions.values())) await t.close();
        sessions.clear();
    }
});

verifies('hosting:http:json-response-mode', async (_args: TestArgs) => {
    const makeServer = () => echoServer();
    const tx = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await makeServer().connect(tx);

    try {
        const res = await tx.handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: {
                    'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream'
                },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
            })
        );

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toMatch(/application\/json/);
        const json = await res.json();
        expect(json).toHaveProperty('result');
    } finally {
        await tx.close();
    }
});

verifies('hosting:http:method-405', async (_args: TestArgs) => {
    // Direct transport so the 405 comes from the SDK, not a hosting helper's method check.
    const tx = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    await echoServer().connect(tx);

    try {
        // HEAD and OPTIONS are the two methods most likely to be special-cased later; the requirement
        // covers ANY unsupported method. In-process there is no HTTP layer to strip a HEAD body, so the
        // transport's JSON error body is observable for all four.
        for (const method of ['PUT', 'PATCH', 'HEAD', 'OPTIONS']) {
            const res = await tx.handleRequest(
                new Request('http://in-process/mcp', { method, headers: { 'mcp-protocol-version': LATEST_PROTOCOL_VERSION } })
            );
            expect(res.status).toBe(405);
            expect(res.headers.get('allow')).toBe('GET, POST, DELETE');
            expect(await res.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' } });
        }
    } finally {
        await tx.close();
    }
});

verifies('hosting:http:no-broadcast', async (_args: TestArgs) => {
    let server!: McpServer;
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
        release = resolve;
    });
    const makeServer = () => {
        server = new McpServer({ name: 's', version: '0' }, { capabilities: { logging: {} } });
        server.registerTool('wait', { inputSchema: z.object({}) }, async () => {
            await gate;
            return { content: [{ type: 'text', text: 'done' }] };
        });
        return server;
    };
    const { handleRequest, close } = hostPerSession(makeServer);

    try {
        const initRes = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: {
                    'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream'
                },
                body: initializeBody()
            })
        );
        const sessionId = initRes.headers.get('mcp-session-id')!;

        const sse = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'GET',
                headers: { accept: 'text/event-stream', 'mcp-protocol-version': LATEST_PROTOCOL_VERSION, 'mcp-session-id': sessionId }
            })
        );
        expect(sse.status).toBe(200);
        const getTap = sseTap(sse.body!);

        // In-flight tools/call keeps a second (POST-initiated) SSE stream open concurrently.
        const post = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: {
                    'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
                    'mcp-session-id': sessionId,
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream'
                },
                body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'wait', arguments: {} } })
            })
        );
        expect(post.status).toBe(200);
        expect(post.headers.get('content-type')).toMatch(/text\/event-stream/);
        const postTap = sseTap(post.body!);

        try {
            await server.server.sendLoggingMessage({ level: 'info', data: 'probe' });

            const received: Array<{ stream: 'get' | 'post'; msg: JSONRPCMessage }> = [];
            const drain = async () => {
                for (const msg of await getTap.poll(50)) {
                    if ('method' in msg && msg.method === 'notifications/message') received.push({ stream: 'get', msg });
                }
                for (const msg of await postTap.poll(50)) {
                    if ('method' in msg && msg.method === 'notifications/message') received.push({ stream: 'post', msg });
                }
            };

            for (let i = 0; i < 10 && received.length === 0; i++) {
                await drain();
            }
            // Keep draining both streams after the first copy so a late duplicate would be caught.
            for (let i = 0; i < 4; i++) {
                await drain();
            }

            expect(received).toHaveLength(1);
            expect(received[0].stream).toBe('get');
            expect(received[0].msg).toMatchObject({ method: 'notifications/message', params: { level: 'info', data: 'probe' } });

            release();
            let response: JSONRPCMessage | undefined;
            for (let i = 0; i < 10 && response === undefined; i++) {
                response = (await postTap.poll(50)).find(m => 'id' in m && m.id === 2);
            }
            expect(response).toMatchObject({ jsonrpc: '2.0', id: 2 });
        } finally {
            release();
            await getTap.cancel();
            await postTap.cancel();
        }
    } finally {
        await close();
    }
});

verifies('hosting:http:notifications-202', async (_args: TestArgs) => {
    const { handleRequest, close } = hostPerSession(echoServer);

    try {
        const initRes = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: {
                    'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream'
                },
                body: initializeBody()
            })
        );
        const sessionId = initRes.headers.get('mcp-session-id')!;

        const notificationOnly = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: {
                    'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
                    'mcp-session-id': sessionId,
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream'
                },
                body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
            })
        );
        expect(notificationOnly.status).toBe(202);
        expect(await notificationOnly.text()).toBe('');

        // The 'or responses' clause: both JSON-RPC response wire shapes — result-bearing and
        // error-bearing — are likewise accepted with 202 and an empty body.
        const sessionHeaders = {
            'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
            'mcp-session-id': sessionId,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream'
        };
        const resultOnly = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: sessionHeaders,
                body: JSON.stringify({ jsonrpc: '2.0', id: 999, result: {} })
            })
        );
        expect(resultOnly.status).toBe(202);
        expect(await resultOnly.text()).toBe('');

        const errorOnly = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: sessionHeaders,
                body: JSON.stringify({ jsonrpc: '2.0', id: 998, error: { code: -32000, message: 'test' } })
            })
        );
        expect(errorOnly.status).toBe(202);
        expect(await errorOnly.text()).toBe('');
    } finally {
        await close();
    }
});

verifies('hosting:http:onerror', async (_args: TestArgs) => {
    const errors: Error[] = [];
    const tx = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    tx.onerror = e => errors.push(e);
    await echoServer().connect(tx);

    try {
        const accept = 'application/json, text/event-stream';
        const base = { 'mcp-protocol-version': LATEST_PROTOCOL_VERSION };
        const init = await tx.handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: { ...base, 'content-type': 'application/json', accept },
                body: initializeBody()
            })
        );
        expect(init.status).toBe(200);
        expect(errors).toHaveLength(0);
        const sessionId = init.headers.get('mcp-session-id')!;
        const ok = { ...base, 'mcp-session-id': sessionId, 'content-type': 'application/json', accept };
        const listBody = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

        const rejections: Array<{ req: Request; status: number; message: string }> = [
            {
                req: new Request('http://in-process/mcp', { method: 'PUT', headers: ok }),
                status: 405,
                message: 'Method not allowed.'
            },
            {
                req: new Request('http://in-process/mcp', {
                    method: 'POST',
                    headers: { ...ok, accept: 'application/json' },
                    body: listBody
                }),
                status: 406,
                message: 'Not Acceptable: Client must accept both application/json and text/event-stream'
            },
            {
                req: new Request('http://in-process/mcp', {
                    method: 'POST',
                    headers: { ...ok, 'content-type': 'text/plain' },
                    body: listBody
                }),
                status: 415,
                message: 'Unsupported Media Type: Content-Type must be application/json'
            },
            {
                req: new Request('http://in-process/mcp', { method: 'POST', headers: ok, body: 'not json' }),
                status: 400,
                message: 'Parse error: Invalid JSON'
            },
            {
                req: new Request('http://in-process/mcp', {
                    method: 'POST',
                    headers: { ...base, 'content-type': 'application/json', accept },
                    body: listBody
                }),
                status: 400,
                message: 'Bad Request: Mcp-Session-Id header is required'
            }
        ];

        for (const { req, status, message } of rejections) {
            const before = errors.length;
            const res = await tx.handleRequest(req);
            expect(res.status).toBe(status);
            expect(errors).toHaveLength(before + 1);
            expect(errors[before].message).toBe(message);
        }

        // Further rejection branches, coupled to onerror by count only (their message texts are
        // deliberately not pinned): valid JSON that is not a JSON-RPC envelope, an unsupported
        // MCP-Protocol-Version header, and a second initialize on the initialized transport.
        const countOnly: Array<{ req: Request; status: number }> = [
            {
                req: new Request('http://in-process/mcp', { method: 'POST', headers: ok, body: '{"foo":1}' }),
                status: 400
            },
            {
                req: new Request('http://in-process/mcp', {
                    method: 'POST',
                    headers: { ...ok, 'mcp-protocol-version': '1999-01-01' },
                    body: listBody
                }),
                status: 400
            },
            {
                req: new Request('http://in-process/mcp', { method: 'POST', headers: ok, body: initializeBody() }),
                status: 400
            }
        ];
        for (const { req, status } of countOnly) {
            const before = errors.length;
            const res = await tx.handleRequest(req);
            expect(res.status).toBe(status);
            expect(errors).toHaveLength(before + 1);
            expect(errors[before]).toBeInstanceOf(Error);
            expect(errors[before].message).not.toBe('');
        }

        // A second standalone GET stream conflicts and is reported; opening the first is not an error.
        const beforeFirstGet = errors.length;
        const getHeaders = { ...base, 'mcp-session-id': sessionId, accept: 'text/event-stream' };
        const sse = await tx.handleRequest(new Request('http://in-process/mcp', { method: 'GET', headers: getHeaders }));
        expect(sse.status).toBe(200);
        expect(errors).toHaveLength(beforeFirstGet);
        try {
            const secondGet = await tx.handleRequest(new Request('http://in-process/mcp', { method: 'GET', headers: getHeaders }));
            expect(secondGet.status).toBe(409);
            expect(errors).toHaveLength(beforeFirstGet + 1);
            expect(errors[beforeFirstGet]).toBeInstanceOf(Error);
            expect(errors[beforeFirstGet].message).not.toBe('');
        } finally {
            await sse.body!.cancel();
        }
    } finally {
        await tx.close();
    }
});

verifies('hosting:http:parse-error-400', async (_args: TestArgs) => {
    const { handleRequest, close } = hostStateless(echoServer);

    try {
        const badJson = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: {
                    'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream'
                },
                body: 'not json'
            })
        );
        expect(badJson.status).toBe(400);
        const body = await badJson.json();
        expect(body).toMatchObject({ jsonrpc: '2.0', error: { code: -32700 } });

        // The behavior's second disjunct — valid JSON that is not a valid JSON-RPC message — with
        // each payload carrying exactly one fault, so a partial envelope check cannot pass them all.
        const invalidEnvelopes = [
            '{"jsonrpc":"2.0"}', // neither request, notification, nor response
            '{"jsonrpc":"2.0","method":"tools/list","id":{}}', // object-typed id
            '{"jsonrpc":"1.0","method":"x","id":1}' // wrong protocol version
        ];
        for (const payload of invalidEnvelopes) {
            const res = await handleRequest(
                new Request('http://in-process/mcp', {
                    method: 'POST',
                    headers: {
                        'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
                        'content-type': 'application/json',
                        accept: 'application/json, text/event-stream'
                    },
                    body: payload
                })
            );
            expect(res.status).toBe(400);
            expect(await res.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32700 } });
        }
    } finally {
        await close();
    }
});

verifies('hosting:http:protocol-version-400', async (_args: TestArgs) => {
    const { handleRequest, close } = hostPerSession(echoServer);

    try {
        // Create a session with supported version
        const initRes = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: {
                    'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream'
                },
                body: initializeBody()
            })
        );
        expect(initRes.status).toBe(200);
        const sessionId = initRes.headers.get('mcp-session-id')!;

        // POST with unsupported version on established session
        const unsupported = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: {
                    'mcp-protocol-version': '1999-01-01',
                    'mcp-session-id': sessionId,
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream'
                },
                body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
            })
        );

        expect(unsupported.status).toBe(400);
        const text = await unsupported.text();
        expect(text).toContain(LATEST_PROTOCOL_VERSION);

        // The spec clause is method-agnostic and the transport validates the header on separate
        // code paths per method — GET (standalone SSE) and DELETE (session terminate) must 400 too.
        const getRes = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'GET',
                headers: { accept: 'text/event-stream', 'mcp-protocol-version': '1999-01-01', 'mcp-session-id': sessionId }
            })
        );
        expect(getRes.status).toBe(400);
        expect(await getRes.text()).toContain(LATEST_PROTOCOL_VERSION);

        const deleteRes = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'DELETE',
                headers: { 'mcp-protocol-version': '1999-01-01', 'mcp-session-id': sessionId }
            })
        );
        expect(deleteRes.status).toBe(400);
        expect(await deleteRes.text()).toContain(LATEST_PROTOCOL_VERSION);
    } finally {
        await close();
    }
});

verifies('hosting:http:protocol-version-default', async (_args: TestArgs) => {
    const { handleRequest, close } = hostPerSession(echoServer);

    try {
        const initRes = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: {
                    'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream'
                },
                body: initializeBody()
            })
        );
        expect(initRes.status).toBe(200);
        const sessionId = initRes.headers.get('mcp-session-id')!;

        // Only Accept, Content-Type, and the session ID — no MCP-Protocol-Version header at all.
        const noVersionHeaders = {
            'mcp-session-id': sessionId,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream'
        };

        // 202 proves the notification was accepted under the assumed default version (2025-03-26).
        const notification = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: noVersionHeaders,
                body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
            })
        );
        expect(notification.status).toBe(202);

        const listRes = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: noVersionHeaders,
                body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
            })
        );
        expect(listRes.status).toBe(200);
        const messages = await readAllSseMessages(listRes.body!);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'echo' }] } });
    } finally {
        await close();
    }
});

verifies('hosting:http:response-same-connection', async (_args: TestArgs) => {
    const { handleRequest, close } = hostPerSession(echoServer);

    try {
        const initRes = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: {
                    'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream'
                },
                body: initializeBody()
            })
        );
        const sessionId = initRes.headers.get('mcp-session-id')!;

        // A concurrently open standalone GET stream is the alternative connection the response must NOT use.
        const sse = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'GET',
                headers: { accept: 'text/event-stream', 'mcp-protocol-version': LATEST_PROTOCOL_VERSION, 'mcp-session-id': sessionId }
            })
        );
        expect(sse.status).toBe(200);
        const getTap = sseTap(sse.body!);

        const res = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: {
                    'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
                    'mcp-session-id': sessionId,
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream'
                },
                body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
            })
        );

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
        const postTap = sseTap(res.body!);

        try {
            let response: JSONRPCMessage | undefined;
            for (let i = 0; i < 10 && response === undefined; i++) {
                response = (await postTap.poll(50)).find(m => 'id' in m && m.id === 2);
            }
            expect(response).toMatchObject({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'echo' }] } });

            for (let i = 0; i < 4; i++) {
                for (const msg of await getTap.poll(50)) {
                    expect(msg).not.toHaveProperty('result');
                    expect(msg).not.toHaveProperty('error');
                }
            }
        } finally {
            await getTap.cancel();
            await postTap.cancel();
        }
    } finally {
        await close();
    }
});

verifies('hosting:http:second-sse-rejected', async (_args: TestArgs) => {
    const { handleRequest, close } = hostPerSession(echoServer);

    try {
        const initRes = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: {
                    'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream'
                },
                body: initializeBody()
            })
        );
        const sessionId = initRes.headers.get('mcp-session-id')!;

        const sse1 = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'GET',
                headers: { accept: 'text/event-stream', 'mcp-protocol-version': LATEST_PROTOCOL_VERSION, 'mcp-session-id': sessionId }
            })
        );
        expect(sse1.status).toBe(200);
        const reader1 = sse1.body!.getReader();

        let reader2: ReadableStreamDefaultReader<Uint8Array> | null = null;
        try {
            const sse2 = await handleRequest(
                new Request('http://in-process/mcp', {
                    method: 'GET',
                    headers: { accept: 'text/event-stream', 'mcp-protocol-version': LATEST_PROTOCOL_VERSION, 'mcp-session-id': sessionId }
                })
            );
            expect(sse2.status).toBe(409);

            // Verify first stream remains usable after rejection
            const testNotif = await handleRequest(
                new Request('http://in-process/mcp', {
                    method: 'POST',
                    headers: {
                        'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
                        'mcp-session-id': sessionId,
                        'content-type': 'application/json',
                        accept: 'application/json, text/event-stream'
                    },
                    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
                })
            );
            expect(testNotif.status).toBe(202);

            // First stream should be readable
            const { done } = await Promise.race([
                reader1.read(),
                new Promise<{ done: boolean }>(r => setTimeout(() => r({ done: false }), 100))
            ]);
            expect(done).toBe(false);

            if (sse2.status === 200) {
                reader2 = sse2.body!.getReader();
            }
        } finally {
            await reader1.cancel();
            if (reader2) await reader2.cancel();
        }
    } finally {
        await close();
    }
});

verifies('hosting:http:sse-close-after-response', async (_args: TestArgs) => {
    // The probe request emits SSE events BEFORE its response, so a transport that closed the stream
    // after its FIRST write (rather than because the response was written) is distinguishable.
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('progress', { inputSchema: z.object({ steps: z.number() }) }, async ({ steps }, extra) => {
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
    const { handleRequest, close } = hostPerSession(makeServer);

    try {
        const initRes = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: {
                    'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream'
                },
                body: initializeBody()
            })
        );
        const sessionId = initRes.headers.get('mcp-session-id')!;

        const res = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: {
                    'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
                    'mcp-session-id': sessionId,
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream'
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/call',
                    params: { name: 'progress', arguments: { steps: 2 }, _meta: { progressToken: 'pt-close' } }
                })
            })
        );

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);

        // readAllSseMessages returns only when the server ends the stream, so termination itself is
        // asserted (a never-closing stream hangs into the test timeout); the frame sequence pins
        // that the close came AFTER the response, which arrives last.
        const messages = await readAllSseMessages(res.body!);
        expect(messages).toHaveLength(3);
        for (const msg of messages.slice(0, 2)) {
            expect(msg).toMatchObject({ method: 'notifications/progress' });
            expect(msg).not.toHaveProperty('result');
            expect(msg).not.toHaveProperty('error');
        }
        expect(messages.at(-1)).toMatchObject({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'done' }] } });
    } finally {
        await close();
    }
});

verifies('hosting:http:standalone-sse', async (_args: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' }, { capabilities: { logging: {} } });
        return s;
    };
    let server!: McpServer;
    const factory = () => {
        server = makeServer();
        return server;
    };
    const { handleRequest, close } = hostPerSession(factory);

    try {
        const initRes = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: {
                    'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream'
                },
                body: initializeBody()
            })
        );
        const sessionId = initRes.headers.get('mcp-session-id')!;

        const sse = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'GET',
                headers: { accept: 'text/event-stream', 'mcp-protocol-version': LATEST_PROTOCOL_VERSION, 'mcp-session-id': sessionId }
            })
        );
        expect(sse.status).toBe(200);
        expect(sse.headers.get('content-type')).toMatch(/text\/event-stream/);

        const tap = sseTap(sse.body!);
        try {
            await server.server.sendLoggingMessage({ level: 'info', data: 'probe' });

            let received: JSONRPCMessage | undefined;
            for (let i = 0; i < 20 && received === undefined; i++) {
                received = (await tap.poll(50)).find(m => 'method' in m && m.method === 'notifications/message');
            }
            expect(received).toMatchObject({ method: 'notifications/message', params: { level: 'info', data: 'probe' } });
        } finally {
            await tap.cancel();
        }
    } finally {
        await close();
    }
});

verifies('hosting:http:standalone-sse-no-response', async (_args: TestArgs) => {
    let server!: McpServer;
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
        release = resolve;
    });
    const factory = () => {
        server = new McpServer({ name: 's', version: '0' }, { capabilities: { logging: {} } });
        server.registerTool('slow', { inputSchema: z.object({}) }, async () => {
            await gate;
            return { content: [{ type: 'text', text: 'late' }] };
        });
        return server;
    };
    const { handleRequest, close } = hostPerSession(factory);

    try {
        const initRes = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: {
                    'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream'
                },
                body: initializeBody()
            })
        );
        const sessionId = initRes.headers.get('mcp-session-id')!;

        const sse = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'GET',
                headers: { accept: 'text/event-stream', 'mcp-protocol-version': LATEST_PROTOCOL_VERSION, 'mcp-session-id': sessionId }
            })
        );
        expect(sse.status).toBe(200);
        expect(sse.headers.get('content-type')).toMatch(/text\/event-stream/);
        const tap = sseTap(sse.body!);

        const seen: JSONRPCMessage[] = [];
        const sawLog = (data: string) =>
            seen.some(
                m => 'method' in m && m.method === 'notifications/message' && (m.params as { data?: unknown } | undefined)?.data === data
            );

        try {
            // Phase 1: notifications are delivered on the standalone stream.
            await server.server.sendLoggingMessage({ level: 'info', data: 'notification' });
            for (let i = 0; i < 20 && !sawLog('notification'); i++) {
                seen.push(...(await tap.poll(50)));
            }
            expect(sawLog('notification')).toBe(true);

            // Phase 2: orphan an in-flight request — POST a gated call, drop its connection before
            // the response exists, then let the handler finish. The orphaned response must NOT be
            // re-routed onto the open standalone GET stream.
            const post = await handleRequest(
                new Request('http://in-process/mcp', {
                    method: 'POST',
                    headers: {
                        'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
                        'mcp-session-id': sessionId,
                        'content-type': 'application/json',
                        accept: 'application/json, text/event-stream'
                    },
                    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'slow', arguments: {} } })
                })
            );
            expect(post.status).toBe(200);
            await post.body!.cancel();
            release();

            // A sentinel emitted after the orphaning bounds the read: any re-routed response would
            // land before the sentinel or in the extra drains below.
            await server.server.sendLoggingMessage({ level: 'info', data: 'after-orphan' });
            for (let i = 0; i < 20 && !sawLog('after-orphan'); i++) {
                seen.push(...(await tap.poll(50)));
            }
            expect(sawLog('after-orphan')).toBe(true);
            for (let i = 0; i < 4; i++) {
                seen.push(...(await tap.poll(50)));
            }

            for (const msg of seen) {
                expect(msg).not.toHaveProperty('result');
                expect(msg).not.toHaveProperty('error');
            }
            expect(seen.some(m => 'id' in m && m.id === 7)).toBe(false);
        } finally {
            release();
            await tap.cancel();
        }
    } finally {
        await close();
    }
});

verifies('hosting:http:send-no-listener-noop', async (_args: TestArgs) => {
    let server!: McpServer;
    const makeServer = () => {
        server = new McpServer({ name: 's', version: '0' }, { capabilities: { logging: {} } });
        return server;
    };
    const { handleRequest, close } = hostPerSession(makeServer);

    try {
        const initRes = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: {
                    'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream'
                },
                body: initializeBody()
            })
        );
        expect(initRes.status).toBe(200);
        const sessionId = initRes.headers.get('mcp-session-id')!;

        await expect(server.server.sendLoggingMessage({ level: 'info', data: 'dropped' })).resolves.not.toThrow();

        // Without an eventStore the message must have been DROPPED, not buffered: a standalone GET
        // stream opened afterwards receives later messages but never the earlier one.
        const sse = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'GET',
                headers: { accept: 'text/event-stream', 'mcp-protocol-version': LATEST_PROTOCOL_VERSION, 'mcp-session-id': sessionId }
            })
        );
        expect(sse.status).toBe(200);
        const tap = sseTap(sse.body!);
        const logData = (m: JSONRPCMessage): unknown =>
            'method' in m && m.method === 'notifications/message' ? (m.params as { data?: unknown } | undefined)?.data : undefined;

        try {
            await server.server.sendLoggingMessage({ level: 'info', data: 'live' });

            const seen: JSONRPCMessage[] = [];
            for (let i = 0; i < 20 && !seen.some(m => logData(m) === 'live'); i++) {
                seen.push(...(await tap.poll(50)));
            }
            // Extra drains so a late flush of the dropped message would still be caught.
            for (let i = 0; i < 4; i++) {
                seen.push(...(await tap.poll(50)));
            }

            expect(seen.some(m => logData(m) === 'live')).toBe(true);
            expect(seen.some(m => logData(m) === 'dropped')).toBe(false);
        } finally {
            await tap.cancel();
        }
    } finally {
        await close();
    }
});
