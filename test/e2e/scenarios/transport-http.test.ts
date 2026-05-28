/**
 * Self-contained test bodies for the StreamableHTTPClientTransport surface.
 *
 * Each export is a {@link TestCase}: builds its own StreamableHTTPClientTransport
 * directly with a counting/intercepting custom fetch, connects it to a Client,
 * and asserts on exactly what the transport sent/did (headers, session id
 * propagation, reconnection attempts, terminateSession, resumption tokens).
 *
 * Pattern: recorder OUTSIDE factories so every server instance shares the same
 * storage; build transport with custom fetch pointing at hostPerSession();
 * close transports/clients in finally so vitest exits cleanly.
 *
 * These tests construct StreamableHTTPClientTransport directly (rather than via wire()) because the
 * transport itself is the subject: a recording fetch in front of the in-process host captures the HTTP
 * traffic the SDK generates, and assertions are made on that recorded traffic — same host fidelity as
 * wire(), with the transport options explicit because they are what is under test.
 */

import { randomUUID } from 'node:crypto';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { JSONRPCRequestSchema } from '@modelcontextprotocol/core';
import {
    LATEST_PROTOCOL_VERSION,
    McpServer,
    SUPPORTED_PROTOCOL_VERSIONS,
    WebStandardStreamableHTTPServerTransport
} from '@modelcontextprotocol/server';
import { expect, vi } from 'vitest';
import { z } from 'zod/v4';

import type { HttpHandler } from '../helpers/index.js';
import { hostPerSession } from '../helpers/index.js';
import { verifies } from '../helpers/verifies.js';
import type { TestArgs } from '../types.js';

const newClient = () => new Client({ name: 'c', version: '0' });

function echoServer(): McpServer {
    const s = new McpServer({ name: 's', version: '0' });
    s.registerTool('echo', { description: 'Echo tool', inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({
        content: [{ type: 'text', text }]
    }));
    return s;
}

const OLDER_VERSION = SUPPORTED_PROTOCOL_VERSIONS.find(v => v !== LATEST_PROTOCOL_VERSION);

interface RecordedRequest {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
}

function headersToRecord(headers: Headers): Record<string, string> {
    const record: Record<string, string> = {};
    for (const [key, value] of headers.entries()) {
        record[key.toLowerCase()] = value;
    }
    return record;
}

function recordingFetch(
    records: RecordedRequest[],
    baseHandler: HttpHandler
): (url: URL | string, init?: RequestInit) => Promise<Response> {
    return async (url, init) => {
        const u = typeof url === 'string' ? url : url.toString();
        const req = new Request(u, init);
        const body = init?.body ? String(init.body) : undefined;
        records.push({ method: req.method, url: u, headers: headersToRecord(req.headers), body });
        return baseHandler(req);
    };
}

/** Narrows away `undefined` for values the surrounding test has already proven exist (replaces non-null assertions). */
function defined<T>(value: T | undefined, label: string): T {
    if (value === undefined) throw new Error(`expected ${label} to be defined`);
    return value;
}

verifies('client-transport:http:session-stored', async (_args: TestArgs) => {
    const records: RecordedRequest[] = [];
    const handle = hostPerSession(() => echoServer());

    try {
        const url = new URL('http://in-process/mcp');
        const transport = new StreamableHTTPClientTransport(url, {
            fetch: recordingFetch(records, handle.handleRequest)
        });

        const client = newClient();
        await client.connect(transport);

        const sessionId = transport.sessionId;
        expect(sessionId).toBeDefined();

        const initReq = records.find(r => r.body?.includes('"method":"initialize"'));
        expect(initReq).toBeDefined();
        const initRequest = defined(initReq, 'recorded initialize request');
        expect(initRequest.headers['mcp-session-id']).toBeUndefined();

        await client.ping();
        await client.listTools();

        const initIdx = records.indexOf(initRequest);
        const subsequent = records.slice(initIdx + 1);
        expect(subsequent.length).toBeGreaterThan(0);
        for (const req of subsequent) {
            expect(req.headers['mcp-session-id']).toBe(sessionId);
        }

        await client.close();
        await transport.close();
    } finally {
        await handle.close();
    }
});

verifies('typescript:client-transport:http:protocol-version-stored', async (_args: TestArgs) => {
    const records: RecordedRequest[] = [];
    const handle = hostPerSession(() => echoServer());

    try {
        const url = new URL('http://in-process/mcp');
        const transport = new StreamableHTTPClientTransport(url, {
            fetch: recordingFetch(records, handle.handleRequest)
        });
        const client = newClient();

        await client.connect(transport);

        expect(transport.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);

        await client.close();
        await transport.close();
    } finally {
        await handle.close();
    }
});

verifies('client-transport:http:protocol-version-header', async (_args: TestArgs) => {
    const records: RecordedRequest[] = [];

    expect(OLDER_VERSION).toBeDefined();
    expect(OLDER_VERSION).not.toBe(LATEST_PROTOCOL_VERSION);
    const olderVersion = defined(OLDER_VERSION, 'older supported protocol version');

    // The server only supports an older spec version, so initialize negotiates the connection down to it
    const handle = hostPerSession(() => {
        const s = new McpServer({ name: 's', version: '0' }, { supportedProtocolVersions: [olderVersion] });
        s.registerTool('echo', { description: 'Echo tool', inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({
            content: [{ type: 'text', text }]
        }));
        return s;
    });

    try {
        const url = new URL('http://in-process/mcp');
        const transport = new StreamableHTTPClientTransport(url, {
            fetch: recordingFetch(records, handle.handleRequest)
        });
        const client = newClient();

        await client.connect(transport);

        await vi.waitFor(() => expect(records.some(r => r.method === 'GET')).toBe(true));

        await client.listTools();
        await client.ping();

        const initIdx = records.findIndex(r => r.body?.includes('"method":"initialize"'));
        expect(initIdx).toBeGreaterThanOrEqual(0);
        const initReq = defined(records[initIdx], 'recorded initialize request');
        expect(initReq.headers['mcp-protocol-version']).toBeUndefined();

        const afterInit = records.slice(initIdx + 1);
        expect(afterInit.length).toBeGreaterThanOrEqual(2);

        for (const req of afterInit) {
            expect(req.headers['mcp-protocol-version']).toBe(olderVersion);
        }

        await client.close();
        await transport.close();
    } finally {
        await handle.close();
    }
});

verifies('client-transport:http:accept-header-get', async (_args: TestArgs) => {
    const records: RecordedRequest[] = [];
    const handle = hostPerSession(() => echoServer());

    try {
        const url = new URL('http://in-process/mcp');
        const transport = new StreamableHTTPClientTransport(url, {
            fetch: recordingFetch(records, handle.handleRequest)
        });
        const client = newClient();

        await client.connect(transport);

        await vi.waitFor(() => expect(records.some(r => r.method === 'GET')).toBe(true));

        const getReqs = records.filter(r => r.method === 'GET');
        expect(getReqs.length).toBeGreaterThan(0);

        for (const req of getReqs) {
            expect(req.headers.accept).toContain('text/event-stream');
        }

        await client.close();
        await transport.close();
    } finally {
        await handle.close();
    }
});

verifies('client-transport:http:accept-header-post', async (_args: TestArgs) => {
    const records: RecordedRequest[] = [];
    const handle = hostPerSession(() => echoServer());

    try {
        const url = new URL('http://in-process/mcp');
        const transport = new StreamableHTTPClientTransport(url, {
            fetch: recordingFetch(records, handle.handleRequest)
        });
        const client = newClient();

        await client.connect(transport);

        const postReqs = records.filter(r => r.method === 'POST');
        expect(postReqs.length).toBeGreaterThan(0);

        for (const req of postReqs) {
            expect(req.headers.accept).toContain('application/json');
            expect(req.headers.accept).toContain('text/event-stream');
        }

        await client.close();
        await transport.close();
    } finally {
        await handle.close();
    }
});

verifies('client-transport:http:custom-headers', async (_args: TestArgs) => {
    const records: RecordedRequest[] = [];
    const handle = hostPerSession(() => echoServer());

    try {
        const url = new URL('http://in-process/mcp');
        const customHeaders = {
            'X-Custom-Header': 'custom-value',
            'X-Another': 'another-value'
        };

        const transport = new StreamableHTTPClientTransport(url, {
            fetch: recordingFetch(records, handle.handleRequest),
            requestInit: { headers: customHeaders }
        });
        const client = newClient();

        await client.connect(transport);

        await client.ping();

        expect(records.length).toBeGreaterThan(0);
        for (const req of records) {
            expect(req.headers['x-custom-header']).toBe('custom-value');
            expect(req.headers['x-another']).toBe('another-value');
        }

        await client.close();
        await transport.close();
    } finally {
        await handle.close();
    }
});

verifies('typescript:client-transport:http:custom-fetch', async (_args: TestArgs) => {
    const customFetchCalls: string[] = [];
    const records: RecordedRequest[] = [];
    const handle = hostPerSession(() => echoServer());

    const customFetch = (url: URL | string, init?: RequestInit) => {
        customFetchCalls.push(typeof url === 'string' ? url : url.toString());
        return recordingFetch(records, handle.handleRequest)(url, init);
    };

    const globalFetchSpy = vi.spyOn(globalThis, 'fetch');

    try {
        const url = new URL('http://in-process/mcp');
        const transport = new StreamableHTTPClientTransport(url, { fetch: customFetch });
        const client = newClient();

        await client.connect(transport);
        await client.callTool({ name: 'echo', arguments: { text: 'hi' } });

        expect(customFetchCalls.length).toBeGreaterThan(0);
        expect(globalFetchSpy).not.toHaveBeenCalled();

        await client.close();
        await transport.close();
    } finally {
        globalFetchSpy.mockRestore();
        await handle.close();
    }
});

verifies('client-transport:http:json-response-parsed', async (_args: TestArgs) => {
    const callResponseContentTypes: Array<string | null> = [];
    const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
    // hostPerSession() defaults to SSE responses, so host inline with enableJsonResponse to exercise the application/json parse path
    const handleRequest: HttpHandler = async req => {
        const sid = req.headers.get('mcp-session-id') ?? undefined;
        const existing = sid ? sessions.get(sid) : undefined;
        if (existing) return existing.handleRequest(req);

        const tx = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID,
            enableJsonResponse: true,
            onsessioninitialized: id => void sessions.set(id, tx)
        });
        await echoServer().connect(tx);
        return tx.handleRequest(req);
    };

    try {
        const url = new URL('http://in-process/mcp');
        const transport = new StreamableHTTPClientTransport(url, {
            fetch: async (u, init) => {
                const response = await handleRequest(new Request(u, init));
                if (init?.body && String(init.body).includes('"tools/call"')) {
                    callResponseContentTypes.push(response.headers.get('content-type'));
                }
                return response;
            }
        });
        const client = newClient();

        await client.connect(transport);

        const result = await client.callTool({ name: 'echo', arguments: { text: 'test' } });

        expect(callResponseContentTypes).toEqual(['application/json']);
        expect(result.content).toEqual([{ type: 'text', text: 'test' }]);

        await client.close();
        await transport.close();
    } finally {
        for (const tx of sessions.values()) await tx.close();
    }
});

verifies('client-transport:http:404-surfaces', async (_args: TestArgs) => {
    const handle = hostPerSession(() => echoServer());
    let sessionIdToBreak: string | undefined;

    try {
        const url = new URL('http://in-process/mcp');
        const transport = new StreamableHTTPClientTransport(url, {
            fetch: async (u, init) => {
                const req = new Request(u, init);
                const sid = req.headers.get('mcp-session-id');
                if (sid && sid === sessionIdToBreak) {
                    return Response.json({ error: 'Session not found' }, { status: 404 });
                }
                return handle.handleRequest(req);
            }
        });
        const client = newClient();

        await client.connect(transport);
        sessionIdToBreak = transport.sessionId;

        const call = client.ping();
        await expect(call).rejects.toThrow();

        await transport.close();
    } finally {
        await handle.close();
    }
});

verifies('client-transport:http:terminate-405-ok', async (_args: TestArgs) => {
    const handle = hostPerSession(() => echoServer());

    try {
        const url = new URL('http://in-process/mcp');
        const transport = new StreamableHTTPClientTransport(url, {
            fetch: async (u, init) => {
                const req = new Request(u, init);
                if (req.method === 'DELETE') {
                    return new Response(null, { status: 405 });
                }
                return handle.handleRequest(req);
            }
        });
        const client = newClient();

        await client.connect(transport);

        await transport.terminateSession();

        await client.close();
        await transport.close();
    } finally {
        await handle.close();
    }
});

verifies('client-transport:http:sse-405-tolerated', async (_args: TestArgs) => {
    const handle = hostPerSession(() => echoServer());

    try {
        const url = new URL('http://in-process/mcp');
        const transport = new StreamableHTTPClientTransport(url, {
            fetch: async (u, init) => {
                const req = new Request(u, init);
                if (req.method === 'GET') {
                    return new Response(null, { status: 405 });
                }
                return handle.handleRequest(req);
            }
        });
        const client = newClient();

        await client.connect(transport);

        await client.ping();

        await client.close();
        await transport.close();
    } finally {
        await handle.close();
    }
});

verifies('client-transport:http:no-reconnect-after-close', async (_args: TestArgs) => {
    const records: RecordedRequest[] = [];
    const transportErrors: Error[] = [];
    const getControllers: Array<ReadableStreamDefaultController<Uint8Array>> = [];
    const handle = hostPerSession(() => echoServer());

    try {
        vi.useFakeTimers();

        const url = new URL('http://in-process/mcp');
        const transport = new StreamableHTTPClientTransport(url, {
            fetch: recordingFetch(records, async req => {
                if (req.method === 'GET') {
                    return new Response(
                        new ReadableStream<Uint8Array>({
                            start(controller) {
                                getControllers.push(controller);
                            }
                        }),
                        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
                    );
                }
                return handle.handleRequest(req);
            }),
            reconnectionOptions: {
                initialReconnectionDelay: 200,
                maxReconnectionDelay: 200,
                reconnectionDelayGrowFactor: 1,
                maxRetries: 10
            }
        });
        transport.onerror = error => void transportErrors.push(error);
        const client = newClient();

        await client.connect(transport);

        await vi.waitFor(() => expect(getControllers.length).toBe(1));

        // Prove the reconnect machinery is live in this setup: an errored GET stream is reconnected after the delay
        defined(getControllers[0], 'first GET stream controller').error(new Error('connection reset'));
        await vi.waitFor(() => expect(records.filter(r => r.method === 'GET').length).toBe(2));
        await vi.waitFor(() => expect(getControllers.length).toBe(2));

        // Error the second stream so a reconnection is pending, then close before its 200ms delay elapses
        defined(getControllers[1], 'second GET stream controller').error(new Error('connection reset'));
        await vi.waitFor(() => expect(transportErrors.filter(e => e.message.includes('SSE stream disconnected')).length).toBe(2), {
            interval: 10
        });

        await client.close();
        await transport.close();

        const requestsAtClose = records.length;
        await vi.advanceTimersByTimeAsync(5000);

        expect(records.filter(r => r.method === 'GET').length).toBe(2);
        expect(records.length).toBe(requestsAtClose);
    } finally {
        vi.useRealTimers();
        await handle.close();
    }
});

verifies('client-transport:http:concurrent-streams', async (_args: TestArgs) => {
    const started: string[] = [];
    const gates = new Map<string, { promise: Promise<void>; release: () => void }>();
    for (const text of ['first', 'second', 'third']) {
        const { promise, resolve } = Promise.withResolvers<void>();
        gates.set(text, { promise, release: resolve });
    }
    const releaseGate = (text: string) => defined(gates.get(text), `gate for ${text}`).release();

    const handle = hostPerSession(() => {
        const s = new McpServer({ name: 's', version: '0' });
        // Gate each call so all three POST SSE streams stay open until the test releases them
        s.registerTool('echo', { description: 'Echo tool', inputSchema: z.object({ text: z.string() }) }, async ({ text }) => {
            started.push(text);
            await gates.get(text)?.promise;
            return { content: [{ type: 'text', text }] };
        });
        return s;
    });

    try {
        const url = new URL('http://in-process/mcp');
        const transport = new StreamableHTTPClientTransport(url, {
            fetch: (u, init) => handle.handleRequest(new Request(u, init))
        });
        const client = newClient();

        await client.connect(transport);

        const firstCall = client.callTool({ name: 'echo', arguments: { text: 'first' } });
        const secondCall = client.callTool({ name: 'echo', arguments: { text: 'second' } });
        const thirdCall = client.callTool({ name: 'echo', arguments: { text: 'third' } });

        await vi.waitFor(() => expect(started.toSorted()).toEqual(['first', 'second', 'third']));

        // Release responses in reverse order: each promise must still receive its own call's text
        releaseGate('third');
        const thirdResult = await thirdCall;
        expect(thirdResult.content).toEqual([{ type: 'text', text: 'third' }]);

        releaseGate('second');
        const secondResult = await secondCall;
        expect(secondResult.content).toEqual([{ type: 'text', text: 'second' }]);

        releaseGate('first');
        const firstResult = await firstCall;
        expect(firstResult.content).toEqual([{ type: 'text', text: 'first' }]);

        await client.close();
        await transport.close();
    } finally {
        await handle.close();
    }
});

verifies('client-transport:http:no-reconnect-after-response', async (_args: TestArgs) => {
    const records: RecordedRequest[] = [];
    const tokens: string[] = [];
    const PRIMING_EVENT_ID = 'call-stream-event-1';
    const encoder = new TextEncoder();
    const handle = hostPerSession(() => echoServer());

    try {
        vi.useFakeTimers();

        const url = new URL('http://in-process/mcp');
        const transport = new StreamableHTTPClientTransport(url, {
            fetch: async (u, init) => {
                const req = new Request(u, init);
                const body = init?.body ? String(init.body) : undefined;
                records.push({ method: req.method, url: u.toString(), headers: headersToRecord(req.headers), body });

                if (req.method === 'GET') {
                    // Refuse the standalone GET so any further GET could only be a reconnection of the POST stream
                    return new Response(null, { status: 405 });
                }

                if (req.method === 'POST' && body?.includes('"tools/call"')) {
                    const requestId = JSONRPCRequestSchema.parse(JSON.parse(body)).id;
                    const response = JSON.stringify({
                        jsonrpc: '2.0',
                        id: requestId,
                        result: { content: [{ type: 'text', text: 'delivered' }] }
                    });
                    // Priming event makes the stream resumable; the response then completes the request before the stream closes
                    return new Response(
                        new ReadableStream<Uint8Array>({
                            start(controller) {
                                controller.enqueue(encoder.encode(`id: ${PRIMING_EVENT_ID}\ndata: \n\n`));
                                controller.enqueue(encoder.encode(`id: call-stream-event-2\ndata: ${response}\n\n`));
                                controller.close();
                            }
                        }),
                        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
                    );
                }

                return handle.handleRequest(req);
            },
            reconnectionOptions: { initialReconnectionDelay: 10, maxReconnectionDelay: 10, reconnectionDelayGrowFactor: 1, maxRetries: 5 }
        });
        const client = newClient();

        await client.connect(transport);

        await vi.waitFor(() => expect(records.filter(r => r.method === 'GET').length).toBe(1));

        const result = await client.callTool(
            { name: 'echo', arguments: { text: 'delivered' } },
            { onresumptiontoken: token => void tokens.push(token) }
        );

        expect(result.content).toEqual([{ type: 'text', text: 'delivered' }]);
        expect(tokens).toContain(PRIMING_EVENT_ID);

        await vi.advanceTimersByTimeAsync(1000);

        const gets = records.filter(r => r.method === 'GET');
        expect(gets).toHaveLength(1);
        expect(gets.filter(r => r.headers['last-event-id'] !== undefined)).toHaveLength(0);

        await client.close();
        await transport.close();
    } finally {
        vi.useRealTimers();
        await handle.close();
    }
});

verifies('client-transport:http:reconnect-retry-value', async (_args: TestArgs) => {
    const RETRY_MS = 100;
    const encoder = new TextEncoder();
    const handle = hostPerSession(() => echoServer());
    const url = new URL('http://in-process/mcp');

    try {
        vi.useFakeTimers();

        // SSE retry: value overrides the default reconnection delay (1000ms with default options)
        {
            const getRecords: Array<{ at: number; lastEventId: string | undefined }> = [];
            const tokens: string[] = [];
            let callRequestId: string | number | undefined;
            let postController: ReadableStreamDefaultController<Uint8Array> | undefined;

            const transport = new StreamableHTTPClientTransport(url, {
                fetch: async (u, init) => {
                    const req = new Request(u, init);
                    const body = init?.body ? String(init.body) : undefined;

                    if (req.method === 'GET') {
                        const lastEventId = req.headers.get('last-event-id') ?? undefined;
                        getRecords.push({ at: Date.now(), lastEventId });
                        if (lastEventId === undefined) {
                            // Refuse the standalone GET so the only resumable GET is the POST-stream reconnection
                            return new Response(null, { status: 405 });
                        }
                        const replayed = JSON.stringify({
                            jsonrpc: '2.0',
                            id: callRequestId,
                            result: { content: [{ type: 'text', text: 'after retry' }] }
                        });
                        return new Response(`id: retry-evt-2\ndata: ${replayed}\n\n`, {
                            status: 200,
                            headers: { 'Content-Type': 'text/event-stream' }
                        });
                    }

                    if (req.method === 'POST' && body?.includes('"tools/call"')) {
                        callRequestId = JSONRPCRequestSchema.parse(JSON.parse(body)).id;
                        return new Response(
                            new ReadableStream<Uint8Array>({
                                start(controller) {
                                    postController = controller;
                                    controller.enqueue(encoder.encode(`retry: ${RETRY_MS}\nid: retry-evt-1\ndata: \n\n`));
                                }
                            }),
                            { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
                        );
                    }

                    return handle.handleRequest(req);
                }
            });
            const client = newClient();

            await client.connect(transport);

            const call = client.callTool(
                { name: 'echo', arguments: { text: 'after retry' } },
                { onresumptiontoken: token => void tokens.push(token) }
            );

            await vi.waitFor(() => expect(tokens).toContain('retry-evt-1'));

            const disconnectedAt = Date.now();
            defined(postController, 'POST SSE stream controller').error(new Error('connection reset'));

            await vi.advanceTimersByTimeAsync(RETRY_MS);
            // Bounded waitFor keeps total advanced time under the 1000ms default delay, so only a retry-honoring reconnect can arrive
            await vi.waitFor(() => expect(getRecords.filter(g => g.lastEventId === 'retry-evt-1')).toHaveLength(1), {
                timeout: 500,
                interval: 10
            });

            const reconnect = defined(
                getRecords.find(g => g.lastEventId === 'retry-evt-1'),
                'reconnection GET carrying the retry event id'
            );
            expect(reconnect.at - disconnectedAt).toBeGreaterThanOrEqual(RETRY_MS);

            const result = await call;
            expect(result.content).toEqual([{ type: 'text', text: 'after retry' }]);

            await client.close();
            await transport.close();
        }

        // Without a retry: field, reconnection backs off exponentially and stops at maxRetries
        {
            const getRecords: Array<{ at: number }> = [];
            const transportErrors: Error[] = [];
            let firstGetController: ReadableStreamDefaultController<Uint8Array> | undefined;

            const transport = new StreamableHTTPClientTransport(url, {
                fetch: async (u, init) => {
                    const req = new Request(u, init);
                    if (req.method === 'GET') {
                        getRecords.push({ at: Date.now() });
                        if (getRecords.length === 1) {
                            return new Response(
                                new ReadableStream<Uint8Array>({
                                    start(controller) {
                                        firstGetController = controller;
                                    }
                                }),
                                { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
                            );
                        }
                        // Fail every reconnection attempt so the next one is scheduled with a grown delay
                        return new Response(null, { status: 500 });
                    }
                    return handle.handleRequest(req);
                },
                reconnectionOptions: {
                    initialReconnectionDelay: 100,
                    maxReconnectionDelay: 10_000,
                    reconnectionDelayGrowFactor: 2,
                    maxRetries: 2
                }
            });
            transport.onerror = error => void transportErrors.push(error);
            const client = newClient();

            await client.connect(transport);

            await vi.waitFor(() => expect(firstGetController).toBeDefined());

            const disconnectedAt = Date.now();
            defined(firstGetController, 'first GET stream controller').error(new Error('connection reset'));

            await vi.waitFor(() => expect(getRecords).toHaveLength(2));
            const secondGet = defined(getRecords[1], 'second GET record');
            expect(secondGet.at - disconnectedAt).toBeGreaterThanOrEqual(100);

            await vi.waitFor(() => expect(getRecords).toHaveLength(3));
            const thirdGet = defined(getRecords[2], 'third GET record');
            expect(thirdGet.at - secondGet.at).toBeGreaterThanOrEqual(200);

            await vi.waitFor(() =>
                expect(transportErrors.some(e => e.message.includes('Maximum reconnection attempts (2) exceeded'))).toBe(true)
            );

            await vi.advanceTimersByTimeAsync(30_000);
            expect(getRecords).toHaveLength(3);

            await client.close();
            await transport.close();
        }
    } finally {
        vi.useRealTimers();
        await handle.close();
    }
});

verifies('client-transport:http:reconnect-get', async (_args: TestArgs) => {
    const records: RecordedRequest[] = [];
    let getStreamCounter = 0;
    const FIRST_EVENT_ID = 'event-id-1';

    const handle = hostPerSession(() => echoServer());

    try {
        vi.useFakeTimers();

        const url = new URL('http://in-process/mcp');
        const transport = new StreamableHTTPClientTransport(url, {
            fetch: async (u, init) => {
                const req = new Request(u, init);
                records.push({
                    method: req.method,
                    url: u.toString(),
                    headers: headersToRecord(req.headers),
                    body: init?.body ? String(init.body) : undefined
                });

                if (req.method === 'GET') {
                    getStreamCounter++;
                    if (getStreamCounter === 1) {
                        const encoder = new TextEncoder();
                        const stream = new ReadableStream({
                            start(controller) {
                                controller.enqueue(encoder.encode(`id: ${FIRST_EVENT_ID}\ndata: {}\n\n`));
                                setTimeout(() => {
                                    controller.error(new Error('simulated disconnect'));
                                }, 10);
                            }
                        });
                        return new Response(stream, {
                            status: 200,
                            headers: { 'Content-Type': 'text/event-stream' }
                        });
                    }
                }

                return handle.handleRequest(req);
            },
            reconnectionOptions: {
                initialReconnectionDelay: 50,
                maxReconnectionDelay: 50,
                reconnectionDelayGrowFactor: 1,
                maxRetries: 2
            }
        });

        const client = newClient();

        await client.connect(transport);

        await vi.waitFor(() => expect(records.filter(r => r.method === 'GET').length).toBeGreaterThanOrEqual(1));

        const firstGet = defined(
            records.find(r => r.method === 'GET'),
            'first GET request'
        );
        expect(firstGet.headers['last-event-id']).toBeUndefined();

        await vi.advanceTimersByTimeAsync(100);

        await vi.waitFor(() => expect(records.filter(r => r.method === 'GET').length).toBeGreaterThanOrEqual(2));

        const secondGet = defined(records.filter(r => r.method === 'GET')[1], 'second GET request');
        expect(secondGet.headers['last-event-id']).toBe(FIRST_EVENT_ID);

        await client.close();
        await transport.close();
    } finally {
        vi.useRealTimers();
        await handle.close();
    }
});

verifies('client-transport:http:reconnect-post-priming', async (_args: TestArgs) => {
    const records: RecordedRequest[] = [];
    const transportErrors: Error[] = [];
    const primedTokens: string[] = [];
    const PRIMING_EVENT_ID = 'post-stream-event-1';
    const REPLAY_EVENT_ID = 'post-stream-event-2';
    let unprimedController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let primedController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let primedRequestId: string | number | undefined;
    const encoder = new TextEncoder();

    const handle = hostPerSession(() => echoServer());

    try {
        const url = new URL('http://in-process/mcp');
        const transport = new StreamableHTTPClientTransport(url, {
            fetch: async (u, init) => {
                const req = new Request(u, init);
                const headers = headersToRecord(req.headers);
                const body = init?.body ? String(init.body) : undefined;
                records.push({ method: req.method, url: u.toString(), headers, body });

                if (req.method === 'GET') {
                    if (headers['last-event-id'] === PRIMING_EVENT_ID && primedRequestId !== undefined) {
                        const replayed = JSON.stringify({
                            jsonrpc: '2.0',
                            id: primedRequestId,
                            result: { content: [{ type: 'text', text: 'with priming' }] }
                        });
                        return new Response(`id: ${REPLAY_EVENT_ID}\ndata: ${replayed}\n\n`, {
                            status: 200,
                            headers: { 'Content-Type': 'text/event-stream' }
                        });
                    }
                    // Refuse the optional standalone GET stream so any GET carrying Last-Event-ID is a POST-stream reconnection
                    return new Response(null, { status: 405 });
                }

                if (req.method === 'POST' && body?.includes('"tools/call"')) {
                    if (body.includes('without priming')) {
                        return new Response(
                            new ReadableStream<Uint8Array>({
                                start(controller) {
                                    unprimedController = controller;
                                }
                            }),
                            { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
                        );
                    }
                    primedRequestId = JSONRPCRequestSchema.parse(JSON.parse(body)).id;
                    return new Response(
                        new ReadableStream<Uint8Array>({
                            start(controller) {
                                primedController = controller;
                                controller.enqueue(encoder.encode(`id: ${PRIMING_EVENT_ID}\ndata: \n\n`));
                            }
                        }),
                        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
                    );
                }

                return handle.handleRequest(req);
            },
            reconnectionOptions: {
                initialReconnectionDelay: 25,
                maxReconnectionDelay: 25,
                reconnectionDelayGrowFactor: 1,
                maxRetries: 2
            }
        });

        transport.onerror = error => {
            transportErrors.push(error);
        };

        const client = newClient();
        await client.connect(transport);

        await vi.waitFor(() => expect(records.filter(r => r.method === 'GET').length).toBe(1));

        // POST stream errored before any priming event: must not be reconnected
        const unprimedCall = client.callTool({ name: 'echo', arguments: { text: 'without priming' } });
        const unprimedOutcome = unprimedCall.then(
            () => 'resolved',
            () => 'rejected'
        );

        await vi.waitFor(() => expect(unprimedController).toBeDefined());
        defined(unprimedController, 'un-primed POST stream controller').error(new Error('connection reset before priming'));
        await vi.waitFor(() => expect(transportErrors.some(e => e.message.includes('SSE stream disconnected'))).toBe(true));

        // POST stream errored after the priming event: must reconnect with Last-Event-ID set to the priming id
        const primedCall = client.callTool(
            { name: 'echo', arguments: { text: 'with priming' } },
            {
                onresumptiontoken: token => {
                    primedTokens.push(token);
                }
            }
        );

        await vi.waitFor(() => expect(primedTokens).toContain(PRIMING_EVENT_ID));
        defined(primedController, 'primed POST stream controller').error(new Error('connection reset after priming'));

        await vi.waitFor(() =>
            expect(records.filter(r => r.method === 'GET' && r.headers['last-event-id'] === PRIMING_EVENT_ID).length).toBe(1)
        );

        const primedResult = await primedCall;
        expect(primedResult.content).toEqual([{ type: 'text', text: 'with priming' }]);

        // An un-primed reconnection would have surfaced earlier as a second GET without Last-Event-ID
        expect(records.filter(r => r.method === 'GET' && r.headers['last-event-id'] === undefined).length).toBe(1);
        expect(records.filter(r => r.method === 'GET').length).toBe(2);

        await client.close();
        await transport.close();

        expect(await unprimedOutcome).toBe('rejected');
    } finally {
        await handle.close();
    }
});

verifies('client-transport:http:resume-stream-api', async (_args: TestArgs) => {
    const records: RecordedRequest[] = [];

    const handle = hostPerSession(() => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('progress', { inputSchema: z.object({ steps: z.number().int().positive() }) }, async ({ steps }, ctx) => {
            const token = ctx.mcpReq._meta?.progressToken;
            if (token !== undefined) {
                for (let i = 1; i <= steps; i++) {
                    await ctx.mcpReq.notify({
                        method: 'notifications/progress',
                        params: { progressToken: token, progress: i, total: steps }
                    });
                }
            }
            return { content: [{ type: 'text', text: `done after ${steps}` }] };
        });
        return s;
    });

    try {
        const url = new URL('http://in-process/mcp');
        const transport = new StreamableHTTPClientTransport(url, {
            fetch: recordingFetch(records, handle.handleRequest)
        });

        const client = newClient();
        await client.connect(transport);

        const sessionId = transport.sessionId;
        expect(sessionId).toBeDefined();

        const tokens: string[] = [];
        await client.callTool(
            { name: 'progress', arguments: { steps: 3 } },
            {
                onprogress: () => {},
                onresumptiontoken: id => {
                    if (id) tokens.push(id);
                }
            }
        );

        if (tokens.length === 0) {
            await client.close();
            await transport.close();
            return;
        }

        const resumeFrom = defined(tokens[0], 'first resumption token');
        const replayed: string[] = [];

        const beforeResume = records.length;
        await transport.resumeStream(resumeFrom, {
            onresumptiontoken: id => replayed.push(id)
        });

        const resumeReq = records.slice(beforeResume).find(r => r.method === 'GET');
        expect(resumeReq).toBeDefined();
        const resumeRequest = defined(resumeReq, 'resume GET request');
        expect(resumeRequest.headers['last-event-id']).toBe(resumeFrom);
        expect(resumeRequest.headers['mcp-session-id']).toBe(sessionId);

        await client.close();
        await transport.close();
    } finally {
        await handle.close();
    }
});

verifies('client-transport:http:body-stream-error-preserved', async (_args: TestArgs) => {
    const originalError = new TypeError('Custom SSE stream TypeError xyz123');
    const handle = hostPerSession(() => echoServer());
    const errors: Error[] = [];

    try {
        const url = new URL('http://in-process/mcp');
        const transport = new StreamableHTTPClientTransport(url, {
            fetch: async (u, init) => {
                const req = new Request(u, init);
                if (req.method === 'GET') {
                    const encoder = new TextEncoder();
                    const stream = new ReadableStream({
                        async start(controller) {
                            controller.enqueue(encoder.encode('data: {}\n\n'));
                            await new Promise(resolve => setTimeout(resolve, 10));
                            controller.error(originalError);
                        }
                    });
                    return new Response(stream, {
                        status: 200,
                        headers: { 'Content-Type': 'text/event-stream' }
                    });
                }
                return handle.handleRequest(req);
            }
        });

        transport.onerror = (error: Error) => {
            errors.push(error);
        };

        const client = newClient();
        await client.connect(transport);

        await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0), { timeout: 2000 });

        const capturedError = errors[0];

        const checkPreserved = (err: unknown, depth = 0): boolean => {
            if (depth > 5 || !err) return false;
            if (err === originalError) return true;
            if (err && typeof err === 'object' && 'cause' in err) return checkPreserved(err.cause, depth + 1);
            return false;
        };

        const isPreserved = checkPreserved(capturedError);
        expect(isPreserved).toBe(true);

        await transport.close();
    } finally {
        await handle.close();
    }
});

verifies('client-transport:http:session-404-reinitialize', async (_args: TestArgs) => {
    const records: RecordedRequest[] = [];
    const handle = hostPerSession(() => echoServer());
    let sessionIdToBreak: string | undefined;
    let shouldBreak = false;

    try {
        const url = new URL('http://in-process/mcp');
        const transport = new StreamableHTTPClientTransport(url, {
            fetch: recordingFetch(records, async req => {
                const sid = req.headers.get('mcp-session-id');
                if (shouldBreak && sid && sid === sessionIdToBreak) {
                    shouldBreak = false;
                    return new Response(null, { status: 404 });
                }
                return handle.handleRequest(req);
            })
        });
        const client = newClient();

        await client.connect(transport);
        const firstSessionId = transport.sessionId;
        expect(firstSessionId).toBeDefined();

        const firstCall = await client.callTool({ name: 'echo', arguments: { text: 'first' } });
        expect(firstCall.content).toEqual([{ type: 'text', text: 'first' }]);

        sessionIdToBreak = firstSessionId;
        shouldBreak = true;

        const secondCall = await client.callTool({ name: 'echo', arguments: { text: 'second' } });
        expect(secondCall.content).toEqual([{ type: 'text', text: 'second' }]);

        const secondSessionId = transport.sessionId;
        expect(secondSessionId).toBeDefined();
        expect(secondSessionId).not.toBe(firstSessionId);

        const initReqs = records.filter(r => r.body?.includes('"method":"initialize"'));
        expect(initReqs.length).toBe(2);
        expect(defined(initReqs[0], 'first initialize request').headers['mcp-session-id']).toBeUndefined();
        expect(defined(initReqs[1], 'second initialize request').headers['mcp-session-id']).toBeUndefined();

        await client.close();
        await transport.close();
    } finally {
        await handle.close();
    }
});
