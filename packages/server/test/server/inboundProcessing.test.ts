import { Readable, Writable } from 'node:stream';

import type { JSONRPCMessage, MessageExtraInfo, Transport } from '@modelcontextprotocol/core-internal';
import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/core-internal';
import { vi } from 'vitest';
import * as z from 'zod/v4';

import { McpServer } from '../../src/server/mcp';
import { serveStdio } from '../../src/server/serveStdio';
import { StdioServerTransport } from '../../src/server/stdio';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(r => {
        resolve = r;
    });
    return { promise, resolve };
}
function fixture(factory: () => McpServer | Promise<McpServer>) {
    const sent: JSONRPCMessage[] = [];
    const wire: Transport = {
        start: async () => {},
        close: async () => {},
        send: vi.fn(async message => {
            sent.push(message);
        })
    };
    const handle = serveStdio(factory, { transport: wire, onerror: () => {} });
    return { wire, handle, sent, receive: (message: JSONRPCMessage, extra?: MessageExtraInfo) => wire.onmessage!(message, extra) };
}
const init = {
    jsonrpc: '2.0' as const,
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } }
};
const envelope = {
    [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
    [CLIENT_INFO_META_KEY]: { name: 'test', version: '1' },
    [CLIENT_CAPABILITIES_META_KEY]: {}
};

test('queued opening completion waits for the real asynchronous factory', async () => {
    const gate = deferred();
    const complete = vi.fn();
    const f = fixture(async () => {
        await gate.promise;
        return new McpServer({ name: 'test', version: '1' });
    });
    f.receive(init, { onMessageProcessed: complete });
    await Promise.resolve();
    expect(complete).not.toHaveBeenCalled();
    gate.resolve();
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    await f.handle.close();
});

test('entry rejection waits for its error response send', async () => {
    const complete = vi.fn();
    const write = deferred();
    const f = fixture(() => new McpServer({ name: 'test', version: '1' }));
    f.wire.send = vi.fn(() => write.promise);
    f.receive(
        { jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: { [PROTOCOL_VERSION_META_KEY]: '2099-01-01' } } },
        { onMessageProcessed: complete }
    );
    await vi.waitFor(() => expect(f.wire.send).toHaveBeenCalledOnce());
    expect(complete).not.toHaveBeenCalled();
    write.resolve();
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    await f.handle.close();
});

test('factory failure completion follows the error response', async () => {
    const complete = vi.fn();
    const write = deferred();
    const f = fixture(() => {
        throw new Error('factory');
    });
    f.wire.send = vi.fn(() => write.promise);
    f.receive(init, { onMessageProcessed: complete });
    await vi.waitFor(() => expect(f.wire.send).toHaveBeenCalledOnce());
    expect(complete).not.toHaveBeenCalled();
    write.resolve();
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    await f.handle.close();
});

test('cancelled tool remains charged through actual handler completion', async () => {
    const entered = deferred();
    const held = deferred();
    const complete = vi.fn();
    const f = fixture(() => {
        const s = new McpServer({ name: 'test', version: '1' });
        s.registerTool('work', { inputSchema: z.object({}) }, async () => {
            entered.resolve();
            await held.promise;
            return { content: [] };
        });
        return s;
    });
    const opened = vi.fn();
    f.receive(init, { onMessageProcessed: opened });
    await vi.waitFor(() => expect(opened).toHaveBeenCalledOnce());
    f.receive({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'work', arguments: {} } }, { onMessageProcessed: complete });
    await entered.promise;
    f.receive({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } });
    await f.handle.close();
    expect(complete).not.toHaveBeenCalled();
    held.resolve();
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect(f.sent.filter(m => 'id' in m && m.id === 2)).toEqual([]);
});

test('listen acknowledgement does not release the subscription request', async () => {
    const complete = vi.fn();
    const f = fixture(() => new McpServer({ name: 'test', version: '1' }, { capabilities: { tools: { listChanged: true } } }));
    const probe = vi.fn();
    f.receive({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: envelope } }, { onMessageProcessed: probe });
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce());
    f.receive(
        {
            jsonrpc: '2.0',
            id: 2,
            method: 'subscriptions/listen',
            params: { _meta: envelope, notifications: { tools: { listChanged: true } } }
        },
        { onMessageProcessed: complete }
    );
    await vi.waitFor(() => expect(f.sent.some(m => 'method' in m && m.method === 'notifications/subscriptions/acknowledged')).toBe(true));
    expect(complete).not.toHaveBeenCalled();
    f.receive({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } });
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
    await f.handle.close();
});

test.skipIf(!process.env.MCP_LIFECYCLE_LONG_RUN)(
    'both protocol generations reuse eight actual completed request IDs for more than ten minutes',
    async () => {
        const duration = 601_000;
        await Promise.all(
            ['legacy', 'modern'].map(async era => {
                let active = 0;
                let peak = 0;
                let completed = 0;
                let replies = 0;
                const ids = new Set<number>();
                const input = new Readable({ read() {} });
                const output = new Writable({
                    write(chunk, _encoding, callback) {
                        const message: JSONRPCMessage = JSON.parse(chunk.toString());
                        expect('error' in message).toBe(false);
                        if ('result' in message && message.id !== 0) expect(JSON.stringify(message.result)).toContain('completed');
                        replies++;
                        setImmediate(callback);
                    }
                });
                const official = new StdioServerTransport(input, output, { maxBufferSize: 1_048_576 });
                const completions = new Map<number, () => void>();
                const wire: Transport = {
                    start: () => official.start(),
                    close: () => official.close(),
                    send: message => official.send(message)
                };
                official.onmessage = message => {
                    if (!('id' in message) || typeof message.id !== 'number') throw new Error('unexpected inbound frame');
                    const complete = completions.get(message.id);
                    if (!complete) throw new Error('unowned inbound frame');
                    wire.onmessage!(message, { onMessageProcessed: complete });
                };
                let handled = 0;
                const handle = serveStdio(
                    () => {
                        const server = new McpServer({ name: 'long-test', version: '1' });
                        server.registerTool('work', { inputSchema: z.object({}) }, async () => {
                            await new Promise<void>(resolve => setImmediate(resolve));
                            handled++;
                            return { content: [{ type: 'text', text: 'completed' }] };
                        });
                        return server;
                    },
                    { transport: wire }
                );
                const request = (id: number, method: string, params: Record<string, unknown>) =>
                    new Promise<void>(resolve => {
                        expect(ids.has(id)).toBe(false);
                        ids.add(id);
                        active++;
                        peak = Math.max(peak, active);
                        completions.set(id, () => {
                            expect(ids.delete(id)).toBe(true);
                            completions.delete(id);
                            active--;
                            completed++;
                            resolve();
                        });
                        input.push(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'));
                    });
                await (era === 'legacy' ? request(0, 'initialize', init.params) : request(0, 'server/discover', { _meta: envelope }));
                const started = performance.now();
                while (performance.now() - started < duration) {
                    await Promise.all(
                        Array.from({ length: 8 }, (_, i) =>
                            request(i + 1, 'tools/call', { name: 'work', arguments: {}, ...(era === 'modern' ? { _meta: envelope } : {}) })
                        )
                    );
                    expect(active).toBe(0);
                    expect(ids.size).toBe(0);
                    await new Promise<void>(resolve => setTimeout(resolve, 1000));
                }
                await request(1, 'tools/call', { name: 'work', arguments: {}, ...(era === 'modern' ? { _meta: envelope } : {}) });
                expect(performance.now() - started).toBeGreaterThan(600_000);
                expect(peak).toBe(8);
                expect(completed).toBeGreaterThan(4000);
                expect(replies).toBe(completed);
                expect(handled).toBe(completed - 1);
                expect(completions.size).toBe(0);
                await handle.close();
                input.destroy();
                output.end();
            })
        );
    },
    630_000
);

test('rejected duplicate listen messages complete without replacing the original subscription', async () => {
    const f = fixture(() => new McpServer({ name: 'test', version: '1' }, { capabilities: { tools: { listChanged: true } } }));
    const opened = vi.fn();
    f.receive({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: envelope } }, { onMessageProcessed: opened });
    await vi.waitFor(() => expect(opened).toHaveBeenCalledOnce());
    const original = vi.fn();
    const params = { _meta: envelope, notifications: { tools: { listChanged: true } } };
    f.receive({ jsonrpc: '2.0', id: 2, method: 'subscriptions/listen', params }, { onMessageProcessed: original });
    await vi.waitFor(() => expect(f.sent.some(m => 'method' in m && m.method === 'notifications/subscriptions/acknowledged')).toBe(true));
    const rejected = vi.fn();
    f.receive(
        { jsonrpc: '2.0', id: 2, method: 'subscriptions/listen', params: { _meta: { [PROTOCOL_VERSION_META_KEY]: '2099-01-01' } } },
        { onMessageProcessed: rejected }
    );
    await vi.waitFor(() => expect(rejected).toHaveBeenCalledOnce());
    expect(original).not.toHaveBeenCalled();
    const duplicate = vi.fn();
    f.receive({ jsonrpc: '2.0', id: 2, method: 'subscriptions/listen', params }, { onMessageProcessed: duplicate });
    await vi.waitFor(() => expect(duplicate).toHaveBeenCalledOnce());
    expect(original).not.toHaveBeenCalled();
    f.receive({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } });
    await vi.waitFor(() => expect(original).toHaveBeenCalledOnce());
    await f.handle.close();
});

test('listen teardown joins held acknowledgement and terminal transmission', async () => {
    const f = fixture(() => new McpServer({ name: 'test', version: '1' }, { capabilities: { tools: { listChanged: true } } }));
    const opened = vi.fn();
    f.receive({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: envelope } }, { onMessageProcessed: opened });
    await vi.waitFor(() => expect(opened).toHaveBeenCalledOnce());
    const ack = deferred();
    const terminal = deferred();
    const complete = vi.fn();
    const written: JSONRPCMessage[] = [];
    f.wire.send = vi.fn(message => {
        written.push(message);
        return 'method' in message && message.method === 'notifications/subscriptions/acknowledged' ? ack.promise : terminal.promise;
    });
    f.receive(
        {
            jsonrpc: '2.0',
            id: 2,
            method: 'subscriptions/listen',
            params: { _meta: envelope, notifications: { tools: { listChanged: true } } }
        },
        { onMessageProcessed: complete }
    );
    await vi.waitFor(() => expect(written.length).toBe(1));
    const close = f.handle.close();
    await vi.waitFor(() => expect(written.length).toBe(2));
    expect(complete).not.toHaveBeenCalled();
    ack.resolve();
    await Promise.resolve();
    expect(complete).not.toHaveBeenCalled();
    terminal.resolve();
    await close;
    expect(complete).toHaveBeenCalledOnce();
});

test('cancelled listeners retain already-started routed notification writes', async () => {
    let server!: McpServer;
    const f = fixture(() => {
        server = new McpServer({ name: 'test', version: '1' }, { capabilities: { tools: { listChanged: true } } });
        return server;
    });
    const opened = vi.fn();
    f.receive({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: { _meta: envelope } }, { onMessageProcessed: opened });
    await vi.waitFor(() => expect(opened).toHaveBeenCalledOnce());
    const a = vi.fn(),
        b = vi.fn();
    const params = { _meta: envelope, notifications: { toolsListChanged: true } };
    f.receive({ jsonrpc: '2.0', id: 2, method: 'subscriptions/listen', params }, { onMessageProcessed: a });
    f.receive({ jsonrpc: '2.0', id: 3, method: 'subscriptions/listen', params }, { onMessageProcessed: b });
    await vi.waitFor(() =>
        expect(f.sent.filter(m => 'method' in m && m.method === 'notifications/subscriptions/acknowledged')).toHaveLength(2)
    );
    const heldA = deferred(),
        heldB = deferred();
    const written: number[] = [];
    f.wire.send = vi.fn(async message => {
        if ('method' in message && message.method === 'notifications/tools/list_changed') {
            const id = message.params!._meta!['io.modelcontextprotocol/subscriptionId'] as number;
            written.push(id);
            await (id === 2 ? heldA : heldB).promise;
        }
    });
    server.sendToolListChanged();
    await vi.waitFor(() => expect(written).toEqual([2, 3]));
    f.receive({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } });
    await Promise.resolve();
    expect(a).not.toHaveBeenCalled();
    heldA.resolve();
    await vi.waitFor(() => expect(a).toHaveBeenCalledOnce());
    f.receive({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } });
    await Promise.resolve();
    expect(b).not.toHaveBeenCalled();
    heldB.resolve();
    await vi.waitFor(() => expect(b).toHaveBeenCalledOnce());
    server.sendToolListChanged();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(written).toEqual([2, 3]);
    await f.handle.close();
});
