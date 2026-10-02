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
import { WebStandardStreamableHTTPServerTransport } from '../../../src/server/webStandardStreamableHttp.js';
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
        const wrongType = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: {
                    'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
                    'content-type': 'text/plain',
                    accept: 'application/json, text/event-stream'
                },
                body: initializeBody()
            })
        );
        expect(wrongType.status).toBe(415);
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
        for (const method of ['PUT', 'PATCH']) {
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

        const res = await handleRequest(
            new Request('http://in-process/mcp', {
                method: 'POST',
                headers: {
                    'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
                    'mcp-session-id': sessionId,
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream'
                },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
            })
        );

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);

        const reader = res.body!.getReader();
        try {
            const decoder = new TextDecoder();
            let buf = '';
            let foundResult = false;

            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });

                const m = buf.match(/^data: (.+)$/m);
                if (m) {
                    const msg = JSON.parse(m[1]);
                    if ('result' in msg) {
                        foundResult = true;
                    }
                }
            }

            expect(foundResult).toBe(true);
        } finally {
            await reader.cancel();
        }
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
            await server.server.sendLoggingMessage({ level: 'info', data: 'notification' });

            let received: JSONRPCMessage | undefined;
            for (let i = 0; i < 20 && received === undefined; i++) {
                for (const msg of await tap.poll(50)) {
                    expect(msg).not.toHaveProperty('result');
                    expect(msg).not.toHaveProperty('error');
                    if ('method' in msg && msg.method === 'notifications/message') {
                        received = msg;
                    }
                }
            }
            expect(received).toMatchObject({ method: 'notifications/message', params: { level: 'info', data: 'notification' } });
        } finally {
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

        await expect(server.server.sendLoggingMessage({ level: 'info', data: 'dropped' })).resolves.not.toThrow();
    } finally {
        await close();
    }
});
