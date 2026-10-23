import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';

import { Client, SSEClientTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';

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

// Sends the headers of a bodiless reply and never ends the response.
const holdOpen = (res: ServerResponse, status = 202, headers?: Record<string, string>) => {
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

describe('POST reply that is never ended', () => {
    let server: Server;

    const listen = async (handler: (req: IncomingMessage, res: ServerResponse) => void) => {
        server = createServer(handler);
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
    };

    afterEach(async () => {
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

    describe.each([
        ['the global fetch', fetch],
        ['a fetch whose reply body is a Node stream, which has no cancel()', fetchWithBody(Readable.from([]))],
        [
            'a fetch whose reply body has a cancel() that throws',
            fetchWithBody({
                cancel() {
                    throw new Error('cancel failed');
                }
            })
        ],
        ['a fetch whose reply body has a cancel() that returns undefined', fetchWithBody({ cancel() {} })]
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

    it('closes the connection of the reply', async () => {
        let closed: Promise<unknown> | undefined;
        const url = await listen((_req, res) => {
            closed = new Promise(resolve => res.on('close', resolve));
            holdOpen(res);
        });
        const transport = new StreamableHTTPClientTransport(url);
        await transport.start();

        await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

        await closed;
        await transport.close();
    });

    it('reads a reply whose body has no cancel()', async () => {
        const replies: Response[] = [];
        const transport = new StreamableHTTPClientTransport(await streamableHttpServer(), { fetch: fetchWithBody({}, replies) });
        await transport.start();

        await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

        expect(replies[0]?.bodyUsed).toBe(true);
        await transport.close();
    });
});
