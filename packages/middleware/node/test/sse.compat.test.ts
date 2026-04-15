import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { JSONRPCMessage } from '@modelcontextprotocol/core';
import { afterEach, describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-deprecated
import { SSEServerTransport } from '../src/sse.js';

describe('SSEServerTransport (deprecated compat shim)', () => {
    let httpServer: Server;
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    let transport: SSEServerTransport;
    let baseUrl: string;

    afterEach(async () => {
        await transport?.close().catch(() => {});
        await new Promise<void>(resolve => httpServer?.close(() => resolve()) ?? resolve());
    });

    async function startServer(): Promise<void> {
        await new Promise<void>(resolve => {
            httpServer = createServer((req, res) => {
                if (req.method === 'GET') {
                    // eslint-disable-next-line @typescript-eslint/no-deprecated
                    transport = new SSEServerTransport('/messages', res);
                    void transport.start();
                } else if (req.method === 'POST') {
                    void transport.handlePostMessage(req, res);
                }
            });
            httpServer.listen(0, '127.0.0.1', resolve);
        });
        const { port } = httpServer.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${port}`;
    }

    it('start() sends endpoint event and handlePostMessage routes JSON-RPC', async () => {
        await startServer();

        const received: JSONRPCMessage[] = [];

        // Open SSE stream and read the endpoint event
        const ctrl = new AbortController();
        const sseRes = await fetch(`${baseUrl}/sse`, {
            headers: { Accept: 'text/event-stream' },
            signal: ctrl.signal
        });
        expect(sseRes.ok).toBe(true);

        transport.onmessage = msg => received.push(msg);

        const reader = sseRes.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        // Read until we see the endpoint event
        while (!buffer.includes('event: endpoint')) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
        }
        expect(buffer).toContain('event: endpoint');
        expect(buffer).toContain(`sessionId=${transport.sessionId}`);

        // POST a JSON-RPC message
        const postRes = await fetch(`${baseUrl}/messages?sessionId=${transport.sessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', method: 'ping', id: 1 })
        });
        expect(postRes.status).toBe(202);
        expect(received).toEqual([{ jsonrpc: '2.0', method: 'ping', id: 1 }]);

        // send() writes to the SSE stream
        await transport.send({ jsonrpc: '2.0', id: 1, result: {} });
        while (!buffer.includes('event: message')) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
        }
        expect(buffer).toContain('event: message');
        expect(buffer).toContain('"result":{}');

        ctrl.abort();
        await reader.cancel().catch(() => {});
    });
});
