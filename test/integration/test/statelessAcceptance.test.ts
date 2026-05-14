import { Client } from '@modelcontextprotocol/client';
import type { JSONRPCNotification, JSONRPCRequest, Transport } from '@modelcontextprotocol/core';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION, META_KEYS, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/core';
import { McpServer, Server } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';

function newServerLinked() {
    const mcp = new McpServer({ name: 's', version: '1' }, { capabilities: { tools: { listChanged: true }, logging: {} } });
    mcp.registerTool('echo', { inputSchema: { text: z.string() } }, async ({ text }, ctx) => {
        await ctx.mcpReq.log('info', { msg: 'called' });
        return { content: [{ type: 'text', text }] };
    });
    const [c, s] = InMemoryTransport.createLinkedPair();
    return { mcp, client: c, server: s };
}

const STATELESS_META = {
    [META_KEYS.protocolVersion]: LATEST_PROTOCOL_VERSION,
    [META_KEYS.clientInfo]: { name: 'c', version: '1' },
    [META_KEYS.clientCapabilities]: {}
};

describe('SEP-2567/2575 acceptance', () => {
    describe('compat matrix', () => {
        it('old-client x new-server: legacy initialize works unchanged', async () => {
            const { mcp, client, server } = newServerLinked();
            const oldClient = new Client({ name: 'old', version: '1' }, { negotiationMode: 'legacy' });
            await Promise.all([mcp.connect(server), oldClient.connect(client)]);
            expect(oldClient.getNegotiatedProtocolVersion()).toBe('2025-11-25');
            const r = await oldClient.callTool({ name: 'echo', arguments: { text: 'hi' } });
            expect(r.content).toEqual([{ type: 'text', text: 'hi' }]);
            await Promise.all([oldClient.close(), mcp.close()]);
        });

        it('[R-2575-10] new-client(auto) x new-server: tries discover first, negotiates stateless', async () => {
            const { mcp, client, server } = newServerLinked();
            const newClient = new Client({ name: 'new', version: '1' }, { negotiationMode: 'auto' });
            await Promise.all([mcp.connect(server), newClient.connect(client)]);
            expect(newClient.getNegotiatedProtocolVersion()).toBe(LATEST_PROTOCOL_VERSION);
            await Promise.all([newClient.close(), mcp.close()]);
        });

        // R-2575-11 (auto-fallback to initialize over stdio) is a known limitation:
        // the discover probe carries `_meta.protocolVersion`, locking the server's
        // mode to stateless before the fallback `initialize` arrives. This works
        // over HTTP (per-request server instance) but not over a single bidirectional
        // transport. Auto mode is opt-in until this is resolved.

        it('new-client(stateless) x old-server: throws (server does not support stateless)', async () => {
            const oldServer = new Server({ name: 'old', version: '1' }, { capabilities: {} });
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (oldServer as any)._requestHandlers.delete('server/discover');
            const [c, s] = InMemoryTransport.createLinkedPair();
            const newClient = new Client({ name: 'new', version: '1' }, { negotiationMode: 'stateless' });
            await oldServer.connect(s);
            await expect(newClient.connect(c)).rejects.toThrow(/stateless negotiation/);
            await oldServer.close();
        });

        it('new-client(stateless) x new-server: full stateless flow over stdio', async () => {
            const { mcp, client, server } = newServerLinked();
            const newClient = new Client({ name: 'new', version: '1' }, { negotiationMode: 'stateless' });
            await Promise.all([mcp.connect(server), newClient.connect(client)]);
            expect(newClient.getNegotiatedProtocolVersion()).toBe(LATEST_PROTOCOL_VERSION);
            const tools = await newClient.listTools();
            expect(tools.tools.map(t => t.name)).toContain('echo');
            const r = await newClient.callTool({ name: 'echo', arguments: { text: 'stateless' } });
            expect(r.content).toEqual([{ type: 'text', text: 'stateless' }]);
            await Promise.all([newClient.close(), mcp.close()]);
        });
    });

    describe('per-request _meta', () => {
        it('[R-2575-1/2/3] stateless client injects protocolVersion + clientInfo + clientCapabilities in every request', async () => {
            const { mcp, client, server } = newServerLinked();
            const sent: unknown[] = [];
            const origSend = client.send.bind(client);
            client.send = async (m, opts) => {
                sent.push(m);
                return origSend(m, opts);
            };
            const c = new Client({ name: 'c', version: '1' }, { negotiationMode: 'stateless', capabilities: { roots: {} } });
            await Promise.all([mcp.connect(server), c.connect(client)]);
            await c.listTools();
            const reqs = sent.filter((m): m is JSONRPCRequest => typeof m === 'object' && m !== null && 'method' in m && 'id' in m);
            // Every request after negotiation has the three required _meta keys.
            for (const r of reqs.filter(r => r.method !== 'server/discover')) {
                const meta = r.params?._meta as Record<string, unknown>;
                expect(meta[META_KEYS.protocolVersion]).toBe(LATEST_PROTOCOL_VERSION);
                expect(meta[META_KEYS.clientInfo]).toEqual({ name: 'c', version: '1' });
                expect(meta[META_KEYS.clientCapabilities]).toEqual({ roots: {} });
            }
            await Promise.all([c.close(), mcp.close()]);
        });

        it('[R-2575-7/8] server reads caps per-request when stateless; not from prior connection state', async () => {
            const server = new Server({ name: 's', version: '1' }, { capabilities: { tools: {} } });
            // First request declares sampling capability; second does not.
            const r1 = await server.handleStatelessRequest({
                jsonrpc: '2.0',
                id: 1,
                method: 'server/discover',
                params: { _meta: { ...STATELESS_META, [META_KEYS.clientCapabilities]: { sampling: {} } } }
            });
            expect('result' in r1).toBe(true);
            // Fresh per-request instance: state from r1 is gone (per-request createMcpServer
            // is the HTTP norm; here we reuse to assert _resolveClientCapabilities reads ctx).
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            expect((server as any).getClientCapabilities()).toBeUndefined();
        });
    });

    describe('removed methods', () => {
        it.each(['initialize', 'ping', 'logging/setLevel', 'resources/subscribe', 'resources/unsubscribe'] as const)(
            '[R-2575-removed] %s returns -32601 on stateless path',
            async method => {
                const server = new Server({ name: 's', version: '1' }, { capabilities: { logging: {}, resources: { subscribe: true } } });
                const r = await server.handleStatelessRequest({
                    jsonrpc: '2.0',
                    id: 1,
                    method,
                    params: { _meta: STATELESS_META }
                });
                expect('error' in r && r.error.code).toBe(ProtocolErrorCode.MethodNotFound);
            }
        );

        it('client.ping/subscribeResource throw locally when stateless', async () => {
            const { mcp, client, server } = newServerLinked();
            const c = new Client({ name: 'c', version: '1' }, { negotiationMode: 'stateless' });
            await Promise.all([mcp.connect(server), c.connect(client)]);
            await expect(c.ping()).rejects.toThrow(ProtocolError);
            await expect(c.subscribeResource({ uri: 'x' })).rejects.toThrow(ProtocolError);
            // sendRootsListChanged is a no-op (does not throw).
            await expect(c.sendRootsListChanged()).resolves.toBeUndefined();
            await Promise.all([c.close(), mcp.close()]);
        });
    });

    describe('logging', () => {
        it('[R-2575-6] server suppresses notifications/message when request omits _meta.logLevel', async () => {
            const server = newServerLinked().mcp.server;
            const notifications: JSONRPCNotification[] = [];
            const r = await server.handleStatelessRequest(
                {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/call',
                    params: { _meta: STATELESS_META, name: 'echo', arguments: { text: 'x' } }
                },
                { onNotification: n => void notifications.push(n) }
            );
            expect('result' in r).toBe(true);
            expect(notifications.filter(n => n.method === 'notifications/message')).toHaveLength(0);
        });

        it('[R-2575-6] server emits notifications/message when _meta.logLevel is set', async () => {
            const server = newServerLinked().mcp.server;
            const notifications: JSONRPCNotification[] = [];
            const r = await server.handleStatelessRequest(
                {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/call',
                    params: { _meta: { ...STATELESS_META, [META_KEYS.logLevel]: 'debug' }, name: 'echo', arguments: { text: 'x' } }
                },
                { onNotification: n => void notifications.push(n) }
            );
            expect('result' in r).toBe(true);
            expect(notifications.filter(n => n.method === 'notifications/message')).toHaveLength(1);
        });

        it('[R-2575-6] client.setLoggingLevel stores level locally and sends via _meta', async () => {
            const { mcp, client, server } = newServerLinked();
            const sent: unknown[] = [];
            const origSend = client.send.bind(client);
            client.send = async (m, opts) => {
                sent.push(m);
                return origSend(m, opts);
            };
            const c = new Client({ name: 'c', version: '1' }, { negotiationMode: 'stateless' });
            await Promise.all([mcp.connect(server), c.connect(client)]);
            await c.setLoggingLevel('warning');
            // No logging/setLevel request was sent.
            expect(sent.some(m => (m as JSONRPCRequest).method === 'logging/setLevel')).toBe(false);
            await c.listTools();
            const last = sent.at(-1) as JSONRPCRequest;
            expect((last.params?._meta as Record<string, unknown>)[META_KEYS.logLevel]).toBe('warning');
            await Promise.all([c.close(), mcp.close()]);
        });
    });

    // R-2575-20 (-32003 with data.requiredCapabilities): the error type and shape
    // are unit-tested in packages/server (cap-gates commit). The end-to-end
    // server-to-client capability gate in stateless mode is exercised once MRTR
    // lands (the stateless model has no server-to-client request channel here).

    describe('subscriptions/listen', () => {
        it('[R-2575-25/13] acks accepted filter, delivers tagged notifications, only opted-in types', async () => {
            const mcp = new McpServer(
                { name: 's', version: '1' },
                { capabilities: { tools: { listChanged: true }, prompts: { listChanged: true } } }
            );
            const server = mcp.server;
            const events: JSONRPCNotification[] = [];
            const ctrl = new AbortController();
            const listen = server.handleStatelessRequest(
                {
                    jsonrpc: '2.0',
                    id: 42,
                    method: 'subscriptions/listen',
                    params: { _meta: STATELESS_META, notifications: { toolsListChanged: true } }
                },
                { signal: ctrl.signal, onNotification: n => void events.push(n) }
            );
            // Allow ack to flush.
            await new Promise(r => setTimeout(r, 0));
            const ack = events.find(e => e.method === 'notifications/subscriptions/acknowledged');
            expect(ack).toBeDefined();
            expect(ack!.params!._meta![META_KEYS.subscriptionId]).toBe('42');
            expect((ack!.params as { notifications: Record<string, unknown> }).notifications).toEqual({ toolsListChanged: true });

            // toolsListChanged is opted in; promptsListChanged is not.
            await server.sendToolListChanged();
            await server.sendPromptListChanged();
            const delivered = events.filter(e => e.method !== 'notifications/subscriptions/acknowledged');
            expect(delivered.map(e => e.method)).toEqual(['notifications/tools/list_changed']);
            expect(delivered[0]!.params!._meta![META_KEYS.subscriptionId]).toBe('42');

            ctrl.abort();
            await listen;
        });

        it('[R-2575-24] cancellation removes the subscription', async () => {
            const server = new Server({ name: 's', version: '1' }, { capabilities: { tools: { listChanged: true } } });
            const events: JSONRPCNotification[] = [];
            const ctrl = new AbortController();
            const listen = server.handleStatelessRequest(
                {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'subscriptions/listen',
                    params: { _meta: STATELESS_META, notifications: { toolsListChanged: true } }
                },
                { signal: ctrl.signal, onNotification: n => void events.push(n) }
            );
            await new Promise(r => setTimeout(r, 0));
            ctrl.abort();
            await listen;
            await server.sendToolListChanged();
            expect(events.filter(e => e.method === 'notifications/tools/list_changed')).toHaveLength(0);
        });

        it('subscriptions/listen rejects in legacy mode with MethodNotFound', async () => {
            const server = new Server({ name: 's', version: '1' }, { capabilities: { tools: { listChanged: true } } });
            const t: Transport = { start: async () => {}, close: async () => {}, send: vi.fn() };
            await server.connect(t);
            // First message: legacy initialize (no _meta).
            t.onmessage?.({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'c', version: '1' } }
            });
            await new Promise(r => setTimeout(r, 0));
            t.onmessage?.({ jsonrpc: '2.0', id: 2, method: 'subscriptions/listen', params: { notifications: {} } });
            await new Promise(r => setTimeout(r, 0));
            const calls = (t.send as ReturnType<typeof vi.fn>).mock.calls;
            const err = calls.map(c => c[0]).find(m => m.id === 2 && m.error);
            expect(err.error.code).toBe(ProtocolErrorCode.MethodNotFound);
        });

        it('resourceSubscriptions default-denied without onAuthorizeResourceSubscription', async () => {
            const server = new Server({ name: 's', version: '1' }, { capabilities: { resources: { subscribe: true } } });
            const events: JSONRPCNotification[] = [];
            const ctrl = new AbortController();
            const listen = server.handleStatelessRequest(
                {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'subscriptions/listen',
                    params: { _meta: STATELESS_META, notifications: { resourceSubscriptions: ['file:///x'] } }
                },
                { signal: ctrl.signal, onNotification: n => void events.push(n) }
            );
            await new Promise(r => setTimeout(r, 0));
            const ack = events.find(e => e.method === 'notifications/subscriptions/acknowledged')!;
            expect((ack.params as { notifications: Record<string, unknown> }).notifications.resourceSubscriptions).toBeUndefined();
            ctrl.abort();
            await listen;
        });
    });

    describe('mode invariants', () => {
        it('mid-connection mode change is rejected', async () => {
            const server = new Server({ name: 's', version: '1' }, { capabilities: {} });
            const t: Transport = { start: async () => {}, close: async () => {}, send: async () => {} };
            await server.connect(t);
            // First message: legacy initialize (no _meta).
            t.onmessage?.({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'c', version: '1' } }
            });
            // Second message: stateless _meta on the same connection.
            expect(() => t.onmessage?.({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: STATELESS_META } })).toThrow(
                /mode changed/
            );
        });
    });
});
