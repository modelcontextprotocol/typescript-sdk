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

import { expect, vi } from 'vitest';
import { z } from 'zod/v4';

import { Client } from '../../../src/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '../../../src/client/streamableHttp.js';
import { McpServer } from '../../../src/server/mcp.js';
import { type EventStore, WebStandardStreamableHTTPServerTransport } from '../../../src/server/webStandardStreamableHttp.js';
import {
    type JSONRPCMessage,
    type JSONRPCRequest,
    JSONRPCRequestSchema,
    LATEST_PROTOCOL_VERSION,
    SUPPORTED_PROTOCOL_VERSIONS
} from '../../../src/types.js';

import { hostPerSession, hostResumable, hostStateless, type HttpHandler } from '../helpers/index.js';
import type { TestArgs } from '../types.js';
import { verifies } from '../helpers/verifies.js';

const newClient = () => new Client({ name: 'c', version: '0' });

function echoServer(): McpServer {
    const s = new McpServer({ name: 's', version: '0' });
    s.registerTool('echo', { description: 'Echo tool', inputSchema: z.object({ text: z.string() }) }, ({ text }) => ({
        content: [{ type: 'text', text }]
    }));
    return s;
}

const OLDER_VERSION = SUPPORTED_PROTOCOL_VERSIONS.find(v => v !== LATEST_PROTOCOL_VERSION)!;

interface RecordedRequest {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
}

function recordingFetch(
    records: RecordedRequest[],
    baseHandler: HttpHandler
): (url: URL | string, init?: RequestInit) => Promise<Response> {
    return async (url, init) => {
        const u = typeof url === 'string' ? url : url.toString();
        const req = new Request(u, init);
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => {
            headers[k.toLowerCase()] = v;
        });
        const body = init?.body ? String(init.body) : undefined;
        records.push({ method: req.method, url: u, headers, body });
        return baseHandler(req);
    };
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
        expect(initReq!.headers['mcp-session-id']).toBeUndefined();

        await client.ping();
        await client.listTools();

        const initIdx = records.indexOf(initReq!);
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
    let claimedVersion = LATEST_PROTOCOL_VERSION;

    const handle = hostPerSession(() => {
        const s = echoServer();
        const origHandlers = (
            s.server as unknown as { _requestHandlers: Map<string, (req: JSONRPCRequest, extra: unknown) => Promise<unknown>> }
        )._requestHandlers;
        const initHandler = origHandlers.get('initialize');
        if (initHandler) {
            origHandlers.set('initialize', async (req: JSONRPCRequest, extra: unknown) => {
                const result = (await initHandler(req, extra)) as { protocolVersion: string };
                return { ...result, protocolVersion: claimedVersion };
            });
        }
        return s;
    });

    try {
        expect(OLDER_VERSION).toBeDefined();
        expect(OLDER_VERSION).not.toBe(LATEST_PROTOCOL_VERSION);

        claimedVersion = OLDER_VERSION;

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
        expect(records[initIdx].headers['mcp-protocol-version']).toBeUndefined();

        const afterInit = records.slice(initIdx + 1);
        expect(afterInit.length).toBeGreaterThanOrEqual(2);

        for (const req of afterInit) {
            expect(req.headers['mcp-protocol-version']).toBe(OLDER_VERSION);
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
                    return new Response(JSON.stringify({ error: 'Session not found' }), {
                        status: 404,
                        headers: { 'Content-Type': 'application/json' }
                    });
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
        getControllers[0].error(new Error('connection reset'));
        await vi.waitFor(() => expect(records.filter(r => r.method === 'GET').length).toBe(2));
        await vi.waitFor(() => expect(getControllers.length).toBe(2));

        // Error the second stream so a reconnection is pending, then close before its 200ms delay elapses
        getControllers[1].error(new Error('connection reset'));
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
        let release!: () => void;
        const promise = new Promise<void>(resolve => {
            release = resolve;
        });
        gates.set(text, { promise, release });
    }

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

        const calls = [
            client.callTool({ name: 'echo', arguments: { text: 'first' } }),
            client.callTool({ name: 'echo', arguments: { text: 'second' } }),
            client.callTool({ name: 'echo', arguments: { text: 'third' } })
        ];

        await vi.waitFor(() => expect([...started].sort()).toEqual(['first', 'second', 'third']));

        // Release responses in reverse order: each promise must still receive its own call's text
        gates.get('third')!.release();
        expect((await calls[2]).content).toEqual([{ type: 'text', text: 'third' }]);

        gates.get('second')!.release();
        expect((await calls[1]).content).toEqual([{ type: 'text', text: 'second' }]);

        gates.get('first')!.release();
        expect((await calls[0]).content).toEqual([{ type: 'text', text: 'first' }]);

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
                const headers: Record<string, string> = {};
                req.headers.forEach((v, k) => {
                    headers[k.toLowerCase()] = v;
                });
                const body = init?.body ? String(init.body) : undefined;
                records.push({ method: req.method, url: u.toString(), headers, body });

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

        const result = await client.callTool({ name: 'echo', arguments: { text: 'delivered' } }, undefined, {
            onresumptiontoken: token => void tokens.push(token)
        });

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

verifies(
    'client-transport:http:no-reconnect-after-response',
    async (_args: TestArgs) => {
        // A JSON-RPC ERROR response completes its request exactly like a result does, so the primed
        // POST stream that delivered it must not be reconnected when it closes.
        const records: RecordedRequest[] = [];
        const tokens: string[] = [];
        const PRIMING_EVENT_ID = 'error-stream-event-1';
        const encoder = new TextEncoder();
        const handle = hostPerSession(() => echoServer());

        try {
            vi.useFakeTimers();

            const url = new URL('http://in-process/mcp');
            const transport = new StreamableHTTPClientTransport(url, {
                fetch: async (u, init) => {
                    const req = new Request(u, init);
                    const headers: Record<string, string> = {};
                    req.headers.forEach((v, k) => {
                        headers[k.toLowerCase()] = v;
                    });
                    const body = init?.body ? String(init.body) : undefined;
                    records.push({ method: req.method, url: u.toString(), headers, body });

                    if (req.method === 'GET') {
                        // Refuse the standalone GET so any further GET could only be a reconnection of the POST stream
                        return new Response(null, { status: 405 });
                    }

                    if (req.method === 'POST' && body?.includes('"tools/call"')) {
                        const requestId = JSONRPCRequestSchema.parse(JSON.parse(body)).id;
                        const response = JSON.stringify({
                            jsonrpc: '2.0',
                            id: requestId,
                            error: { code: -32603, message: 'tool exploded' }
                        });
                        // Priming event makes the stream resumable; the ERROR response then completes the request before the stream closes
                        return new Response(
                            new ReadableStream<Uint8Array>({
                                start(controller) {
                                    controller.enqueue(encoder.encode(`id: ${PRIMING_EVENT_ID}\ndata: \n\n`));
                                    controller.enqueue(encoder.encode(`id: error-stream-event-2\ndata: ${response}\n\n`));
                                    controller.close();
                                }
                            }),
                            { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
                        );
                    }

                    return handle.handleRequest(req);
                },
                reconnectionOptions: {
                    initialReconnectionDelay: 10,
                    maxReconnectionDelay: 10,
                    reconnectionDelayGrowFactor: 1,
                    maxRetries: 5
                }
            });
            const client = newClient();

            await client.connect(transport);

            await vi.waitFor(() => expect(records.filter(r => r.method === 'GET').length).toBe(1));

            const call = client.callTool({ name: 'echo', arguments: { text: 'never delivered' } }, undefined, {
                onresumptiontoken: token => void tokens.push(token)
            });
            await expect(call).rejects.toMatchObject({ code: -32603 });
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
    },
    { title: 'error response' }
);

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

            const call = client.callTool({ name: 'echo', arguments: { text: 'after retry' } }, undefined, {
                onresumptiontoken: token => void tokens.push(token)
            });

            await vi.waitFor(() => expect(tokens).toContain('retry-evt-1'));

            const disconnectedAt = Date.now();
            postController!.error(new Error('connection reset'));

            await vi.advanceTimersByTimeAsync(RETRY_MS);
            // Bounded waitFor keeps total advanced time under the 1000ms default delay, so only a retry-honoring reconnect can arrive
            await vi.waitFor(() => expect(getRecords.filter(g => g.lastEventId === 'retry-evt-1')).toHaveLength(1), {
                timeout: 500,
                interval: 10
            });

            const reconnect = getRecords.find(g => g.lastEventId === 'retry-evt-1')!;
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
                    maxReconnectionDelay: 10000,
                    reconnectionDelayGrowFactor: 2,
                    maxRetries: 2
                }
            });
            transport.onerror = error => void transportErrors.push(error);
            const client = newClient();

            await client.connect(transport);

            await vi.waitFor(() => expect(firstGetController).toBeDefined());

            const disconnectedAt = Date.now();
            firstGetController!.error(new Error('connection reset'));

            await vi.waitFor(() => expect(getRecords).toHaveLength(2));
            expect(getRecords[1].at - disconnectedAt).toBeGreaterThanOrEqual(100);

            await vi.waitFor(() => expect(getRecords).toHaveLength(3));
            expect(getRecords[2].at - getRecords[1].at).toBeGreaterThanOrEqual(200);

            await vi.waitFor(() =>
                expect(transportErrors.some(e => e.message.includes('Maximum reconnection attempts (2) exceeded'))).toBe(true)
            );

            await vi.advanceTimersByTimeAsync(30000);
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
                const headers: Record<string, string> = {};
                req.headers.forEach((v, k) => {
                    headers[k.toLowerCase()] = v;
                });
                records.push({
                    method: req.method,
                    url: u.toString(),
                    headers,
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

        await vi.waitFor(() => records.filter(r => r.method === 'GET').length >= 1);

        const firstGet = records.find(r => r.method === 'GET');
        expect(firstGet!.headers['last-event-id']).toBeUndefined();

        await vi.advanceTimersByTimeAsync(100);

        await vi.waitFor(() => records.filter(r => r.method === 'GET').length >= 2);

        const secondGet = records.filter(r => r.method === 'GET')[1];
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
                const headers: Record<string, string> = {};
                req.headers.forEach((v, k) => {
                    headers[k.toLowerCase()] = v;
                });
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
        unprimedController!.error(new Error('connection reset before priming'));
        await vi.waitFor(() => expect(transportErrors.some(e => e.message.includes('SSE stream disconnected'))).toBe(true));

        // POST stream errored after the priming event: must reconnect with Last-Event-ID set to the priming id
        const primedCall = client.callTool({ name: 'echo', arguments: { text: 'with priming' } }, undefined, {
            onresumptiontoken: token => {
                primedTokens.push(token);
            }
        });

        await vi.waitFor(() => expect(primedTokens).toContain(PRIMING_EVENT_ID));
        primedController!.error(new Error('connection reset after priming'));

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

    // Minimal in-memory EventStore: the host emits SSE event ids only when one is configured, so
    // without it the tool call surfaces no resumption tokens and resumeStream() is never exercised.
    const events: Array<{ id: string; streamId: string; message: JSONRPCMessage }> = [];
    let seq = 0;
    const eventStore: EventStore = {
        storeEvent: async (streamId, message) => {
            const id = `${streamId}_${String(seq++).padStart(6, '0')}`;
            events.push({ id, streamId, message });
            return id;
        },
        replayEventsAfter: async (lastEventId, { send }) => {
            const idx = events.findIndex(e => e.id === lastEventId);
            if (idx < 0) return '';
            const streamId = events[idx].streamId;
            for (const e of events.slice(idx + 1)) {
                if (e.streamId === streamId) await send(e.id, e.message);
            }
            return streamId;
        }
    };

    const handle = hostResumable(
        () => {
            const s = new McpServer({ name: 's', version: '0' });
            s.registerTool('progress', { inputSchema: z.object({ steps: z.number().int().positive() }) }, async ({ steps }, extra) => {
                const token = extra._meta?.progressToken;
                if (token !== undefined) {
                    for (let i = 1; i <= steps; i++) {
                        await extra.sendNotification({
                            method: 'notifications/progress',
                            params: { progressToken: token, progress: i, total: steps }
                        });
                    }
                }
                return { content: [{ type: 'text', text: `done after ${steps}` }] };
            });
            return s;
        },
        { eventStore }
    );

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
        await client.callTool({ name: 'progress', arguments: { steps: 3 } }, undefined, {
            onprogress: () => {},
            onresumptiontoken: id => {
                if (id) tokens.push(id);
            }
        });

        // The resumable host gives every SSE event an id, so the call must surface resumption tokens.
        expect(tokens.length).toBeGreaterThan(0);

        // Resume from the FIRST event of the call stream: everything after it (the progress
        // notifications and the response) counts as missed and must be replayed.
        const resumeFrom = tokens[0];
        const replayed: string[] = [];

        // Tap the transport's message stream: the replayed JSON-RPC payloads themselves must arrive,
        // not just their event ids through onresumptiontoken.
        const seen: JSONRPCMessage[] = [];
        const origOnMessage = transport.onmessage;
        transport.onmessage = m => {
            seen.push(m);
            origOnMessage?.(m);
        };
        // Replaying the already-settled tools/call response surfaces an unknown-message-id error; irrelevant here.
        client.onerror = () => {};

        const beforeResume = records.length;
        await transport.resumeStream(resumeFrom, {
            onresumptiontoken: id => replayed.push(id)
        });

        const resumeReq = records.slice(beforeResume).find(r => r.method === 'GET');
        expect(resumeReq).toBeDefined();
        expect(resumeReq!.headers['last-event-id']).toBe(resumeFrom);
        expect(resumeReq!.headers['mcp-session-id']).toBe(sessionId);

        // The missed notifications arrive as full payloads, in order, on the resumed stream.
        await vi.waitFor(
            () => {
                const progress = seen
                    .filter(m => 'method' in m && m.method === 'notifications/progress')
                    .map(m => ((m as { params?: { progress?: number } }).params ?? {}).progress);
                expect(progress).toEqual([1, 2, 3]);
            },
            { timeout: 2000 }
        );
        expect(replayed.length).toBeGreaterThan(0);

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
                            // Prime with a VALID JSON-RPC notification (silently dropped by the client): a malformed
                            // frame would put a parse error in front of the disconnect wrapper in errors[], and the
                            // knownFailure flip below could never fire.
                            controller.enqueue(
                                encoder.encode('data: {"jsonrpc":"2.0","method":"notifications/resources/list_changed"}\n\n')
                            );
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
        expect(initReqs[0].headers['mcp-session-id']).toBeUndefined();
        expect(initReqs[1].headers['mcp-session-id']).toBeUndefined();

        await client.close();
        await transport.close();
    } finally {
        await handle.close();
    }
});

verifies('client-transport:http:error-status-code', async (_args: TestArgs) => {
    const handle = hostPerSession(() => echoServer());

    const expectStreamableHTTPError = (err: unknown, code: number): void => {
        expect(err).toBeInstanceOf(StreamableHTTPError);
        expect(err instanceof StreamableHTTPError ? err.code : undefined).toBe(code);
    };

    try {
        const url = new URL('http://in-process/mcp');

        // 404 on the connect POST: connect rejects with a StreamableHTTPError carrying the status on .code
        {
            const transport = new StreamableHTTPClientTransport(url, {
                fetch: async () => new Response('Not Found', { status: 404 })
            });
            const client = newClient();

            const err = await client.connect(transport).then(
                () => undefined,
                (e: unknown) => e
            );
            expectStreamableHTTPError(err, 404);

            await transport.close();
        }

        // 401 with no authProvider configured: rejects with .code 401 so callers can branch on auth failures
        {
            const transport = new StreamableHTTPClientTransport(url, {
                fetch: async () => new Response('Unauthorized', { status: 401 })
            });
            const client = newClient();

            const err = await client.connect(transport).then(
                () => undefined,
                (e: unknown) => e
            );
            expectStreamableHTTPError(err, 401);

            await transport.close();
        }

        // 500 on a POST after a successful connect: the in-flight request rejects with .code 500
        {
            let failToolCalls = false;
            const transport = new StreamableHTTPClientTransport(url, {
                fetch: async (u, init) => {
                    const body = init?.body ? String(init.body) : undefined;
                    if (failToolCalls && body?.includes('"tools/call"')) {
                        return new Response('Internal Server Error', { status: 500 });
                    }
                    return handle.handleRequest(new Request(u, init));
                }
            });
            const client = newClient();

            await client.connect(transport);
            failToolCalls = true;

            const err = await client.callTool({ name: 'echo', arguments: { text: 'boom' } }).then(
                () => undefined,
                (e: unknown) => e
            );
            expectStreamableHTTPError(err, 500);

            await client.close();
            await transport.close();
        }
    } finally {
        await handle.close();
    }
});

verifies('typescript:client-transport:http:session-id-property', async (_args: TestArgs) => {
    const serverAssignedIds: Array<string | null> = [];
    const handle = hostPerSession(() => echoServer());
    const statelessHandle = hostStateless(() => echoServer());

    try {
        const url = new URL('http://in-process/mcp');
        const transport = new StreamableHTTPClientTransport(url, {
            fetch: async (u, init) => {
                const response = await handle.handleRequest(new Request(u, init));
                if (init?.body && String(init.body).includes('"method":"initialize"')) {
                    serverAssignedIds.push(response.headers.get('mcp-session-id'));
                }
                return response;
            }
        });
        const client = newClient();

        expect(transport.sessionId).toBeUndefined();

        await client.connect(transport);

        expect(serverAssignedIds).toHaveLength(1);
        const assigned = serverAssignedIds[0];
        expect(assigned).not.toBeNull();
        expect(transport.sessionId).toBe(assigned);

        await client.close();
        await transport.close();

        // Stateless hosting assigns no Mcp-Session-Id, so the property stays undefined after connect
        const statelessTransport = new StreamableHTTPClientTransport(url, {
            fetch: (u, init) => statelessHandle.handleRequest(new Request(u, init))
        });
        const statelessClient = newClient();

        expect(statelessTransport.sessionId).toBeUndefined();

        await statelessClient.connect(statelessTransport);

        expect(statelessTransport.sessionId).toBeUndefined();

        await statelessClient.close();
        await statelessTransport.close();
    } finally {
        await handle.close();
        await statelessHandle.close();
    }
});

verifies('typescript:client-transport:http:session-id-option', async (_args: TestArgs) => {
    const records: RecordedRequest[] = [];
    const handle = hostPerSession(() => echoServer());

    try {
        const url = new URL('http://in-process/mcp');

        // Establish a real session first so the configured sessionId refers to a live server session
        const firstTransport = new StreamableHTTPClientTransport(url, {
            fetch: (u, init) => handle.handleRequest(new Request(u, init))
        });
        const firstClient = newClient();
        await firstClient.connect(firstTransport);

        const sessionId = firstTransport.sessionId;
        if (sessionId === undefined) throw new Error('expected the first connection to negotiate a session id');

        const reusingTransport = new StreamableHTTPClientTransport(url, {
            sessionId,
            fetch: recordingFetch(records, handle.handleRequest)
        });
        const reusingClient = newClient();

        await reusingClient.connect(reusingTransport);

        const result = await reusingClient.callTool({ name: 'echo', arguments: { text: 'reused session' } });
        expect(result.content).toEqual([{ type: 'text', text: 'reused session' }]);

        expect(reusingTransport.sessionId).toBe(sessionId);
        expect(records.length).toBeGreaterThanOrEqual(1);
        expect(records[0].method).toBe('POST');
        expect(records[0].headers['mcp-session-id']).toBe(sessionId);
        for (const req of records) {
            expect(req.headers['mcp-session-id']).toBe(sessionId);
        }

        await reusingClient.close();
        await reusingTransport.close();
        await firstClient.close();
        await firstTransport.close();
    } finally {
        await handle.close();
    }
});

verifies('client-transport:http:reconnect-failure-onerror', async (_args: TestArgs) => {
    const records: RecordedRequest[] = [];
    const transportErrors: Error[] = [];
    let firstGetController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let getCount = 0;
    const handle = hostPerSession(() => echoServer());

    try {
        const url = new URL('http://in-process/mcp');
        const transport = new StreamableHTTPClientTransport(url, {
            fetch: recordingFetch(records, async req => {
                if (req.method === 'GET') {
                    getCount++;
                    if (getCount === 1) {
                        return new Response(
                            new ReadableStream<Uint8Array>({
                                start(controller) {
                                    firstGetController = controller;
                                }
                            }),
                            { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
                        );
                    }
                    // Every reconnection attempt fails so the retry budget is exhausted
                    return new Response('Not Found', { status: 404 });
                }
                return handle.handleRequest(req);
            }),
            reconnectionOptions: {
                initialReconnectionDelay: 10,
                maxReconnectionDelay: 10,
                reconnectionDelayGrowFactor: 1,
                maxRetries: 2
            }
        });
        transport.onerror = error => void transportErrors.push(error);
        const client = newClient();

        await client.connect(transport);

        await vi.waitFor(() => expect(firstGetController).toBeDefined());
        firstGetController?.error(new Error('connection reset'));

        // Each failed attempt and the final budget-exhausted failure are delivered to onerror
        await vi.waitFor(() =>
            expect(transportErrors.filter(e => e.message === 'Maximum reconnection attempts (2) exceeded.')).toHaveLength(1)
        );
        expect(transportErrors.filter(e => e.message.startsWith('Failed to reconnect SSE stream:'))).toHaveLength(2);
        expect(records.filter(r => r.method === 'GET')).toHaveLength(3);

        // The reconnection failure stays on onerror: an unrelated request issued afterwards still succeeds
        const result = await client.callTool({ name: 'echo', arguments: { text: 'still works' } });
        expect(result.content).toEqual([{ type: 'text', text: 'still works' }]);
        expect(records.filter(r => r.method === 'GET')).toHaveLength(3);

        await client.close();
        await transport.close();
    } finally {
        await handle.close();
    }
});
