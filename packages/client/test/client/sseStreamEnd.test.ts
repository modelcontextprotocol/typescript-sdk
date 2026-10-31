import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { LATEST_PROTOCOL_VERSION, SdkErrorCode } from '@modelcontextprotocol/core-internal';

import { Client } from '../../src/client/client';
import { SSEClientTransport } from '../../src/client/sse';

test('a pending request rejects and onclose fires when the SSE stream drops and cannot be reopened', async () => {
    let gets = 0;
    let write: ((data: string) => void) | undefined;
    let end: (() => void) | undefined;
    const server = createServer((req, res) => {
        if (req.method === 'GET') {
            gets++;
            if (gets > 1) {
                res.writeHead(404).end();
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write('event: endpoint\ndata: /messages\n\n');
            write = data => res.write(`event: message\ndata: ${data}\n\n`);
            end = () => res.end();
            return;
        }
        let body = '';
        req.on('data', chunk => (body += chunk));
        req.on('end', () => {
            res.writeHead(202).end();
            const message = JSON.parse(body);
            if (message.method === 'initialize') {
                write?.(
                    JSON.stringify({
                        jsonrpc: '2.0',
                        id: message.id,
                        result: {
                            protocolVersion: LATEST_PROTOCOL_VERSION,
                            capabilities: { tools: {} },
                            serverInfo: { name: 's', version: '1' }
                        }
                    })
                );
            } else if (message.method === 'tools/list') {
                end?.(); // the server goes away before answering
            }
        });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    try {
        const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/sse`);
        const client = new Client({ name: 'c', version: '1' });
        client.onerror = () => {};
        const closed = new Promise<void>(resolve => (client.onclose = resolve));
        await client.connect(new SSEClientTransport(url));

        const pending = client.listTools(undefined, { timeout: 30_000 });
        await expect(pending).rejects.toMatchObject({ code: SdkErrorCode.ConnectionClosed });
        await closed;
        expect(gets).toBe(2);
    } finally {
        server.close();
    }
}, 15_000);
