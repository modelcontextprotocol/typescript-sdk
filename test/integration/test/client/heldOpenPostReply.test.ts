import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';

import { Client, SSEClientTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

const initializeResult = (id: unknown) => ({
    jsonrpc: '2.0',
    id,
    result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'held-open', version: '1.0.0' } }
});

const readJson = async (req: IncomingMessage) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    return JSON.parse(raw);
};

// Settles when the connection of the last held-open reply closes.
let closed: Promise<unknown>;

// Sends the headers of a bodiless reply and never ends the response.
const holdOpen = (res: ServerResponse, status = 202, headers?: Record<string, string>) => {
    closed = new Promise(resolve => res.on('close', resolve));
    res.writeHead(status, headers);
    res.flushHeaders();
};

// A fetch whose POST replies carry `body` in place of their own.
const fetchWithBody =
    (body: unknown, replies: Response[] = []): typeof fetch =>
    async (input, init) => {
        const response = await fetch(input, init);
        if (init?.method !== 'POST') return response;
        replies.push(response);
        return Object.defineProperty(response, 'body', { value: body });
    };

// A mock that is called with each rejection that nothing handles, until the test ends.
const watchUnhandledRejections = () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    onTestFinished(() => void process.off('unhandledRejection', unhandled));
    return unhandled;
};

const notification = { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 1, progress: 1 } } as const;

// The four kinds of 2xx POST reply whose body a transport does not read; send() rejects on the third.
const unreadReplies = [
    ['a 202 reply', { status: 202, message: notification }],
    ['a 200 reply to a notification', { status: 200, message: notification }],
    [
        'a 200 reply with an unexpected content type',
        { status: 200, headers: { 'content-type': 'text/plain' }, message: { jsonrpc: '2.0', id: 1, method: 'ping' } }
    ],
    ['a reply on the SSE transport', { status: 202, message: notification, sse: true }]
] as const;
const accepted = unreadReplies[0][1];

describe('POST reply whose body the client does not read', () => {
    let server: Server;

    const listen = async (handler: (req: IncomingMessage, res: ServerResponse) => void) => {
        server = createServer(handler);
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
    };

    afterEach(async () => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    });

    const streamableHttpServer = () =>
        listen(async (req, res) => {
            if (req.method !== 'POST') {
                res.writeHead(405).end();
                return;
            }
            const message = await readJson(req);
            if (message.method === 'initialize') {
                res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(initializeResult(message.id)));
                return;
            }
            holdOpen(res);
        });

    const sseServer = () => {
        let stream: ServerResponse | undefined;
        return listen(async (req, res) => {
            if (req.method === 'GET') {
                res.writeHead(200, { 'content-type': 'text/event-stream' });
                res.write('event: endpoint\ndata: /messages\n\n');
                stream = res;
                return;
            }
            const message = await readJson(req);
            holdOpen(res);
            if (message.method === 'initialize') {
                stream?.write(`event: message\ndata: ${JSON.stringify(initializeResult(message.id))}\n\n`);
            }
        });
    };

    // Starts a transport whose next POST gets `reply`: held open by the server, or with `body` and without the network.
    const start = async ({ status, headers, sse }: { status: number; headers?: Record<string, string>; sse?: boolean }, body?: unknown) => {
        const url = sse ? await sseServer() : await listen((_req, res) => holdOpen(res, status, headers));
        const fetchWithoutPost: typeof fetch = async (input, init) =>
            init?.method === 'POST'
                ? Object.defineProperty(new Response(null, { status, headers }), 'body', { value: body })
                : fetch(input, init);
        const options = body === undefined ? {} : { fetch: fetchWithoutPost };
        const transport = sse ? new SSEClientTransport(url, options) : new StreamableHTTPClientTransport(url, options);
        await transport.start();
        return transport;
    };

    describe.each([
        ['the global fetch', fetch],
        ['a fetch whose reply body is a Node stream, which has no getReader()', fetchWithBody(Readable.from([]))],
        [
            'a fetch whose reply body has a getReader() that throws',
            fetchWithBody({
                getReader() {
                    throw new Error('locked');
                }
            })
        ],
        [
            'a fetch whose reply body has a read() that rejects',
            fetchWithBody({ getReader: () => ({ read: () => Promise.reject(new Error('read failed')) }) })
        ]
    ])('with %s', (_name, fetch) => {
        it('does not stall send() on the streamable HTTP transport', async () => {
            const transport = new StreamableHTTPClientTransport(await streamableHttpServer(), { fetch });
            await transport.start();

            await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

            await transport.close();
        });

        it('does not stall Client.connect() over streamable HTTP', async () => {
            const client = new Client({ name: 'test', version: '1.0.0' });

            await client.connect(new StreamableHTTPClientTransport(await streamableHttpServer(), { fetch }));

            expect(client.getServerVersion()?.name).toBe('held-open');
            await client.close();
        });

        it('does not stall send() of a notification on a 200 reply', async () => {
            const url = await listen((_req, res) => holdOpen(res, 200));
            const transport = new StreamableHTTPClientTransport(url, { fetch });
            await transport.start();

            await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

            await transport.close();
        });

        it('does not stall the rejection of a reply with an unexpected content type', async () => {
            const url = await listen((_req, res) => holdOpen(res, 200, { 'content-type': 'text/plain' }));
            const transport = new StreamableHTTPClientTransport(url, { fetch });
            await transport.start();

            await expect(transport.send({ jsonrpc: '2.0', id: 1, method: 'ping' })).rejects.toThrow('Unexpected content type: text/plain');

            await transport.close();
        });

        it('does not stall send() on the SSE transport', async () => {
            const transport = new SSEClientTransport(await sseServer(), { fetch });
            await transport.start();

            await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

            await transport.close();
        });

        it('does not stall Client.connect() over SSE', async () => {
            const client = new Client({ name: 'test', version: '1.0.0' });

            await client.connect(new SSEClientTransport(await sseServer(), { fetch }));

            expect(client.getServerVersion()?.name).toBe('held-open');
            await client.close();
        });
    });

    it('does not stall send() when a custom fetch has cloned the response', async () => {
        const url = await listen((req, res) => {
            req.resume();
            res.writeHead(202).end();
        });
        const fetchWithClone: typeof fetch = async (input, init) => {
            const response = await fetch(input, init);
            response.clone();
            return response;
        };
        const transport = new StreamableHTTPClientTransport(url, { fetch: fetchWithClone });
        await transport.start();

        await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

        await transport.close();
    });

    it('leaves no unhandled rejection when a custom fetch returns a clone of the response', async () => {
        const url = await listen((req, res) => {
            req.resume();
            res.writeHead(202).end();
        });
        const originals: Response[] = [];
        const fetchReturningClone: typeof fetch = async (input, init) => {
            const response = await fetch(input, init);
            originals.push(response);
            return response.clone();
        };
        const unhandled = watchUnhandledRejections();
        const transport = new StreamableHTTPClientTransport(url, { fetch: fetchReturningClone });
        await transport.start();

        await transport.send(notification);
        await transport.close();

        await new Promise(resolve => setTimeout(resolve, 10));
        expect(unhandled).not.toHaveBeenCalled();
    });

    it('does not cut a reply that ends after its headers', async () => {
        let ended: Promise<boolean> | undefined;
        const url = await listen((req, res) => {
            ended = new Promise(resolve => res.on('close', () => resolve(res.writableFinished && !req.socket.destroyed)));
            res.writeHead(202);
            res.flushHeaders();
            setTimeout(() => res.end(), 10);
        });
        const transport = new StreamableHTTPClientTransport(url);
        await transport.start();

        await transport.send(notification);

        expect(await ended).toBe(true);
        await transport.close();
    });

    describe.each(unreadReplies)('%s', (_name, reply) => {
        it('has its connection closed when it never ends', async () => {
            const transport = await start(reply);

            await transport.send(reply.message).catch(() => {});

            await closed;
            await transport.close();
        });

        it('is cancelled when it has not ended after 100 ms, and send() does not wait for that', async () => {
            const cancel = vi.fn();
            const transport = await start(reply, new ReadableStream({ cancel }));
            vi.useFakeTimers();

            await transport.send(reply.message).catch(() => {});

            await vi.advanceTimersByTimeAsync(99);
            expect(cancel).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            expect(cancel).toHaveBeenCalledOnce();
            await transport.close();
        });

        it('is read to its end and not cancelled when it ends', async () => {
            const cancel = vi.fn();
            const pull = vi.fn((controller: ReadableStreamDefaultController) =>
                pull.mock.calls.length < 3 ? controller.enqueue(new Uint8Array(1)) : controller.close()
            );
            const transport = await start(reply, new ReadableStream({ pull, cancel }, { highWaterMark: 0 }));
            vi.useFakeTimers();

            await transport.send(reply.message).catch(() => {});

            await vi.advanceTimersByTimeAsync(0);
            expect(pull).toHaveBeenCalledTimes(3);
            expect(vi.getTimerCount()).toBe(0);
            expect(cancel).not.toHaveBeenCalled();
            await transport.close();
        });
    });

    it('leaves no timer when the body fails', async () => {
        const transport = await start(accepted, new ReadableStream({ start: controller => controller.error(new Error('failed')) }));
        vi.useFakeTimers();

        await transport.send(notification);

        await vi.advanceTimersByTimeAsync(0);
        expect(vi.getTimerCount()).toBe(0);
        await transport.close();
    });

    it.each([
        [
            'throws',
            () => {
                throw new Error('cancel failed');
            }
        ],
        ['rejects', () => Promise.reject(new Error('cancel failed'))],
        ['returns undefined', () => {}],
        ['never settles', () => new Promise(() => {})]
    ])('tolerates a cancel() that %s', async (_name, cancel) => {
        const unhandled = watchUnhandledRejections();
        const transport = await start(accepted, { getReader: () => ({ read: () => new Promise(() => {}), cancel }) });
        vi.useFakeTimers();

        await transport.send(notification);

        await vi.advanceTimersByTimeAsync(100);
        expect(unhandled).not.toHaveBeenCalled();
        await transport.close();
    });

    it('reads a reply whose body has no getReader()', async () => {
        const replies: Response[] = [];
        const transport = new StreamableHTTPClientTransport(await streamableHttpServer(), { fetch: fetchWithBody({}, replies) });
        await transport.start();

        await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

        expect(replies[0]?.bodyUsed).toBe(true);
        await transport.close();
    });
});
