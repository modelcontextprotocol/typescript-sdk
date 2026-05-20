import { Client } from '@modelcontextprotocol/client';
import type { JSONRPCNotification } from '@modelcontextprotocol/core';
import { InMemoryTransport, isStatelessProtocolVersion, META_KEYS, ProtocolErrorCode } from '@modelcontextprotocol/core';
import type { StatelessHandlers } from '@modelcontextprotocol/server';
import { handleHttp, InMemorySubscriptions, McpServer, Server } from '@modelcontextprotocol/server';
import { describe, expect, test } from 'vitest';

import { LegacyTestClient } from './__fixtures__/testClient.js';

const STATELESS_META = {
    [META_KEYS.protocolVersion]: 'DRAFT-2026-v1',
    [META_KEYS.clientInfo]: { name: 't', version: '1' },
    [META_KEYS.clientCapabilities]: {}
};

function jreq(id: number, method: string, params?: Record<string, unknown>) {
    return { jsonrpc: '2.0' as const, id, method, params: { ...params, _meta: STATELESS_META } };
}

function makeServer(): Server {
    const mcp = new McpServer({ name: 'srv', version: '1' }, { capabilities: { tools: { listChanged: true }, logging: {} } });
    mcp.registerTool('echo', { description: 'echo', inputSchema: {} }, async (_args, ctx) => {
        await ctx.mcpReq.log('info', 'handling echo');
        return { content: [{ type: 'text', text: 'ok' }] };
    });
    mcp.registerTool('elicit', { description: 'elicit', inputSchema: {} }, async (_args, ctx) => {
        const r = await ctx.mcpReq.elicitInput({ message: 'q', requestedSchema: { type: 'object', properties: {} } });
        return { content: [{ type: 'text', text: r.action }] };
    });
    return mcp.server;
}

describe('Server stateless dispatch', () => {
    const d: StatelessHandlers['dispatch'] = new Server({ name: 's', version: '1' }, { capabilities: {} }).statelessHandlers().dispatch;

    test('R-2575: server/discover returns supportedVersions/capabilities/serverInfo', async () => {
        const r = await d(jreq(1, 'server/discover'), { notify: () => {} });
        expect('result' in r && (r.result as { supportedVersions: string[] }).supportedVersions).toContain('DRAFT-2026-v1');
    });

    test('R-2575: removed methods return -32601', async () => {
        for (const m of ['initialize', 'ping', 'logging/setLevel', 'resources/subscribe']) {
            const r = await d(jreq(1, m), { notify: () => {} });
            expect('error' in r && r.error.code).toBe(ProtocolErrorCode.MethodNotFound);
        }
    });

    test('R-2575: resultType filled to complete when absent', async () => {
        const server = new Server({ name: 's', version: '1' }, { capabilities: {} });
        server.fallbackRequestHandler = async () => ({});
        const r = await server.statelessHandlers().dispatch(jreq(1, 'x'), { notify: () => {} });
        expect('result' in r && (r.result as { resultType: string }).resultType).toBe('complete');
    });

    test('R-2322: InputRequiredError without client cap → -32003', async () => {
        const server = makeServer();
        const r = await server.statelessHandlers().dispatch(jreq(1, 'tools/call', { name: 'elicit', arguments: {} }), {
            notify: () => {}
        });
        expect('error' in r && r.error.code).toBe(ProtocolErrorCode.MissingRequiredClientCapability);
        expect('error' in r && (r.error.data as { requiredCapabilities: object }).requiredCapabilities).toEqual({ elicitation: {} });
    });

    test('R-2575: ctx.mcpReq.log gates on _meta.logLevel', async () => {
        const server = makeServer();
        const dd = server.statelessHandlers().dispatch;
        const seen: JSONRPCNotification[] = [];
        const r = await dd(jreq(1, 'tools/call', { name: 'echo', arguments: {} }), {
            notify: n => seen.push(n)
        });
        expect('result' in r).toBe(true);
        expect(seen).toHaveLength(0); // no logLevel in _meta → suppressed
        // With logLevel:
        const seen2: JSONRPCNotification[] = [];
        await dd(
            {
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/call',
                params: { name: 'echo', arguments: {}, _meta: { ...STATELESS_META, [META_KEYS.logLevel]: 'info' } }
            },
            { notify: n => seen2.push(n) }
        );
        expect(seen2.map(n => n.method)).toContain('notifications/message');
    });
});

describe('SubscriptionBackend', () => {
    test('handle → ack first; notify delivers; close ends', async () => {
        const subs = new InMemorySubscriptions();
        const { stream, close } = subs.handle(
            { id: 7, method: 'subscriptions/listen', params: { notifications: { toolsListChanged: true } } },
            {},
            { tools: { listChanged: true } }
        );
        const it = stream[Symbol.asyncIterator]();
        const ack = await it.next();
        expect((ack.value as JSONRPCNotification).method).toBe('notifications/subscriptions/acknowledged');
        const subId = ((ack.value as JSONRPCNotification).params!._meta as Record<string, string>)[META_KEYS.subscriptionId];
        expect(subId).toBe('7'); // SEP-2575: subscriptionId is the listen request's JSON-RPC id
        subs.notify({ type: 'toolsListChanged' });
        const n = await it.next();
        expect((n.value as JSONRPCNotification).method).toBe('notifications/tools/list_changed');
        close();
        const last = await it.next();
        expect(last.done).toBe(true);
    });

    test('resourceSubscriptions fail-closed without onAuthorizeResourceSubscription', async () => {
        const subs = new InMemorySubscriptions();
        const { stream } = subs.handle(
            { id: 8, method: 'subscriptions/listen', params: { notifications: { resourceSubscriptions: ['file:///a'] } } },
            {},
            { resources: { subscribe: true } }
        );
        // Ack filter should NOT include resourceSubscriptions.
        const first = await stream[Symbol.asyncIterator]().next();
        const ack = first.value as JSONRPCNotification;
        expect((ack.params as { notifications: Record<string, unknown> }).notifications.resourceSubscriptions).toBeUndefined();
    });
});

describe('handleHttp', () => {
    const handler = handleHttp(makeServer());

    test('POST tools/list → 200 JSON', async () => {
        const res = await handler(
            new Request('http://x/mcp', {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'mcp-protocol-version': 'DRAFT-2026-v1' },
                body: JSON.stringify(jreq(1, 'tools/list'))
            })
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { result: { tools: unknown[] } };
        expect(body.result.tools.length).toBeGreaterThan(0);
    });

    test('R-2575: GET → 405', async () => {
        const res = await handler(new Request('http://x/mcp', { method: 'GET' }));
        expect(res.status).toBe(405);
    });

    test('R-2575: unknown method → 404', async () => {
        const res = await handler(
            new Request('http://x/mcp', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(jreq(1, 'unknown/method'))
            })
        );
        expect(res.status).toBe(404);
    });

    test('R-2243: header/body version mismatch → 400 -32001', async () => {
        const res = await handler(
            new Request('http://x/mcp', {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'mcp-protocol-version': 'DRAFT-2026-v2' },
                body: JSON.stringify(jreq(1, 'tools/list'))
            })
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: { code: number } }).error.code).toBe(ProtocolErrorCode.HeaderMismatch);
    });

    test('subscriptions/listen without Accept SSE → 406', async () => {
        const res = await handler(
            new Request('http://x/mcp', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(jreq(1, 'subscriptions/listen', { notifications: { toolsListChanged: true } }))
            })
        );
        expect(res.status).toBe(406);
    });

    test('subscriptions/listen in batch → 400', async () => {
        const res = await handler(
            new Request('http://x/mcp', {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
                body: JSON.stringify([jreq(1, 'subscriptions/listen', { notifications: {} }), jreq(2, 'tools/list')])
            })
        );
        expect(res.status).toBe(400);
    });

    test('empty batch → 400', async () => {
        const res = await handler(
            new Request('http://x/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[]' })
        );
        expect(res.status).toBe(400);
    });

    test('allowedHosts handles bracketed IPv6 (validateHostHeader convention)', async () => {
        const h = handleHttp(makeServer(), { allowedHosts: ['[::1]'] });
        const res = await h(
            new Request('http://x/mcp', {
                method: 'POST',
                headers: { host: '[::1]:3000', 'content-type': 'application/json' },
                body: JSON.stringify(jreq(1, 'server/discover'))
            })
        );
        expect(res.status).toBe(200);
    });

    test('allowedOrigins rejects missing Origin', async () => {
        const h = handleHttp(makeServer(), { allowedOrigins: ['https://ok'] });
        const res = await h(new Request('http://x/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
        expect(res.status).toBe(403);
    });

    test('rejects non-JSON Content-Type with 415', async () => {
        const h = handleHttp(makeServer());
        const res = await h(new Request('http://x/mcp', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }));
        expect(res.status).toBe(415);
    });

    test('rejects oversize batch with 400', async () => {
        const h = handleHttp(makeServer());
        const big = Array.from({ length: 65 }, (_, i) => jreq(i, 'server/discover'));
        const res = await h(
            new Request('http://x/mcp', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(big)
            })
        );
        expect(res.status).toBe(400);
    });
});

describe('Client over InMemory (stateless end-to-end)', () => {
    test('connect auto-probes discover, negotiates stateless, callTool via sendAndReceive', async () => {
        const [c, s] = InMemoryTransport.createLinkedPair();
        const server = makeServer();
        await server.connect(s);
        const client = new Client({ name: 'c', version: '1' });
        await client.connect(c);
        expect(isStatelessProtocolVersion(client.getNegotiatedProtocolVersion()!)).toBe(true);
        const r = await client.callTool({ name: 'echo', arguments: {} });
        expect((r.content as { text: string }[])[0]?.text).toBe('ok');
        await client.close();
    });

    test('LegacyTestClient negotiates legacy; server-to-client elicitation works', async () => {
        const [c, s] = InMemoryTransport.createLinkedPair();
        const server = makeServer();
        await server.connect(s);
        const client = new LegacyTestClient({ name: 'c', version: '1' }, { capabilities: { elicitation: {} } });
        client.setRequestHandler('elicitation/create', async () => ({ action: 'accept', content: {} }));
        await client.connect(c);
        expect(isStatelessProtocolVersion(client.getNegotiatedProtocolVersion()!)).toBe(false);
        const r = await client.callTool({ name: 'elicit', arguments: {} });
        expect((r.content as { text: string }[])[0]?.text).toBe('accept');
        await client.close();
    });

    test('R-2575: subscribe() over InMemory delivers ack and list_changed (stdio-shaped demux)', async () => {
        const [c, s] = InMemoryTransport.createLinkedPair();
        const server = makeServer();
        await server.connect(s);
        const client = new Client({ name: 'c', version: '1' });
        await client.connect(c);

        const seen: string[] = [];
        const sub = client.subscribe({ toolsListChanged: true });
        const it = sub[Symbol.asyncIterator]();
        const ack = await it.next();
        expect((ack.value as JSONRPCNotification).method).toBe('notifications/subscriptions/acknowledged');

        await server.sendToolListChanged();
        const evt = await it.next();
        expect((evt.value as JSONRPCNotification).method).toBe('notifications/tools/list_changed');
        seen.push((evt.value as JSONRPCNotification).method);

        await it.return?.();
        await client.close();
        expect(seen).toEqual(['notifications/tools/list_changed']);
    });

    test('R-2322: MRTR auto-resume — stateless callTool that elicits', async () => {
        const [c, s] = InMemoryTransport.createLinkedPair();
        const server = makeServer();
        await server.connect(s);
        const client = new Client({ name: 'c', version: '1' }, { capabilities: { elicitation: { form: {} } } });
        client.setRequestHandler('elicitation/create', async () => ({ action: 'accept', content: {} }));
        await client.connect(c);
        const r = await client.callTool({ name: 'elicit', arguments: {} });
        expect((r.content as { text: string }[])[0]?.text).toBe('accept');
        await client.close();
    });
});

describe('Zero-change consumer (StreamableHTTP router serves both eras)', () => {
    test('one transport.handleRequest serves legacy initialize AND stateless discover', async () => {
        const { WebStandardStreamableHTTPServerTransport } = await import('@modelcontextprotocol/server');
        const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => 'sid' });
        const server = makeServer();
        await server.connect(transport);

        // 2026-06 stateless: header present
        const r1 = await transport.handleRequest(
            new Request('http://x/mcp', {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    accept: 'application/json',
                    'mcp-protocol-version': 'DRAFT-2026-v1'
                },
                body: JSON.stringify(jreq(1, 'server/discover'))
            })
        );
        expect(r1.status).toBe(200);
        expect(((await r1.json()) as { result: { supportedVersions: string[] } }).result.supportedVersions).toContain('DRAFT-2026-v1');

        // Legacy: no header → handleStatefulRequest → initialize works
        const r2 = await transport.handleRequest(
            new Request('http://x/mcp', {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'initialize',
                    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'c', version: '1' } }
                })
            })
        );
        expect(r2.status).toBe(200);
        // SSE body; just check it's not an error status.
    });
});

describe('Audit invariants', () => {
    test('stateless dispatch writes nothing to per-client instance state', async () => {
        const server = new Server({ name: 's', version: '1' }, { capabilities: {} });
        server.fallbackRequestHandler = async () => ({});
        const d = server.statelessHandlers().dispatch;
        const before = server.legacy.getClientCapabilities();
        await Promise.all([1, 2, 3, 4, 5].map(i => d(jreq(i, 'x'), { notify: () => {} })));
        expect(server.legacy.getClientCapabilities()).toBe(before);
        expect(server.legacy.getClientVersion()).toBeUndefined();
    });
});
