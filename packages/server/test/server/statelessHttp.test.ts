import type { JSONRPCResultResponse, StatelessHandlers } from '@modelcontextprotocol/core';
import { DRAFT_PROTOCOL_VERSION, JSONRPC_VERSION, META_KEYS } from '@modelcontextprotocol/core';
import { describe, expect, it } from 'vitest';

import { handleHttp } from '../../src/server/handleHttp.js';
import { LegacyServer as Server } from '../../src/server/legacyServer.js';
import { statelessHttpHandler } from '../../src/server/statelessHttp.js';

const _meta = {
    [META_KEYS.protocolVersion]: DRAFT_PROTOCOL_VERSION,
    [META_KEYS.clientInfo]: { name: 'c', version: '1' },
    [META_KEYS.clientCapabilities]: {}
};

function rpc(method: string, id: number | string = 1, extra: object = {}): object {
    return { jsonrpc: JSONRPC_VERSION, id, method, params: { _meta, ...extra } };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
    return new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body)
    });
}

const echoHandlers: StatelessHandlers = {
    dispatch: async req => ({ jsonrpc: JSONRPC_VERSION, id: req.id, result: { method: req.method } }),
    listen: () => ({ stream: (async function* () {})(), close: () => {} })
};

describe('statelessHttpHandler', () => {
    it('returns 415 for wrong Content-Type', async () => {
        const req = new Request('http://localhost/mcp', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: '{}'
        });
        const res = await statelessHttpHandler(echoHandlers, req);
        expect(res.status).toBe(415);
    });

    it('returns 405 for non-POST', async () => {
        const res = await statelessHttpHandler(echoHandlers, new Request('http://localhost/mcp', { method: 'GET' }));
        expect(res.status).toBe(405);
        expect(res.headers.get('Allow')).toBe('POST');
    });

    it('returns 400 for empty batch', async () => {
        const res = await statelessHttpHandler(echoHandlers, post([]));
        expect(res.status).toBe(400);
    });

    it('returns 400 for batch over cap', async () => {
        const batch = Array.from({ length: 65 }, (_, i) => rpc('server/discover', i));
        const res = await statelessHttpHandler(echoHandlers, post(batch));
        expect(res.status).toBe(400);
    });

    it('returns 413 when body exceeds maxBodyBytes', async () => {
        const big = 'x'.repeat(200);
        const res = await statelessHttpHandler(echoHandlers, post(big), { maxBodyBytes: 100 });
        expect(res.status).toBe(413);
    });

    it('rejects messages that are neither request nor notification', async () => {
        const res = await statelessHttpHandler(echoHandlers, post([{ jsonrpc: '2.0', id: 1, result: {} }]));
        expect(res.status).toBe(400);
    });

    it('returns 400 when _meta.protocolVersion missing', async () => {
        const res = await statelessHttpHandler(echoHandlers, post({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }));
        expect(res.status).toBe(400);
    });

    it('returns 400 on header/meta version mismatch', async () => {
        const res = await statelessHttpHandler(echoHandlers, post(rpc('server/discover'), { 'MCP-Protocol-Version': '1999-01-01' }));
        expect(res.status).toBe(400);
    });

    it('dispatches a single request and returns JSON', async () => {
        const res = await statelessHttpHandler(echoHandlers, post(rpc('server/discover')));
        expect(res.status).toBe(200);
        const body = (await res.json()) as JSONRPCResultResponse;
        expect(body.result).toEqual({ method: 'server/discover' });
    });

    it('subscriptions/listen requires SSE accept', async () => {
        const res = await statelessHttpHandler(echoHandlers, post(rpc('subscriptions/listen', 1, { notifications: {} })));
        expect(res.status).toBe(406);
    });

    it('subscriptions/listen cannot be batched', async () => {
        const res = await statelessHttpHandler(
            echoHandlers,
            post([rpc('subscriptions/listen', 1, { notifications: {} }), rpc('server/discover', 2)], {
                Accept: 'text/event-stream'
            })
        );
        expect(res.status).toBe(400);
    });

    it('returns 202 for notification-only POST', async () => {
        const res = await statelessHttpHandler(echoHandlers, post([{ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }]));
        expect(res.status).toBe(202);
    });
});

describe('handleHttp', () => {
    function srv() {
        return new Server({ name: 's', version: '1' }, { capabilities: {} });
    }

    it('rejects forbidden Host before auth', async () => {
        let authCalled = false;
        const h = handleHttp(srv(), {
            allowedHosts: ['localhost'],
            auth: async () => {
                authCalled = true;
                return undefined;
            }
        });
        const res = await h(post(rpc('server/discover'), { Host: 'evil.com' }));
        expect(res.status).toBe(403);
        expect(authCalled).toBe(false);
    });

    it('allowedHosts uses validateHostHeader convention (bracketed IPv6)', async () => {
        const h = handleHttp(srv(), { allowedHosts: ['[::1]'] });
        const res = await h(post(rpc('server/discover'), { Host: '[::1]:3000' }));
        expect(res.status).toBe(200);
    });

    it('rejects missing Origin when allowedOrigins set', async () => {
        const h = handleHttp(srv(), { allowedOrigins: ['http://localhost'] });
        const res = await h(post(rpc('server/discover')));
        expect(res.status).toBe(403);
    });

    it('passes auth result through to dispatch', async () => {
        const server = srv();
        server.fallbackRequestHandler = async (_, ctx) => ({ token: ctx.http?.authInfo?.token });
        const h = handleHttp(server, { auth: async () => ({ token: 't', clientId: 'c', scopes: [] }) });
        const res = await h(post(rpc('acme/x')));
        const body = (await res.json()) as JSONRPCResultResponse;
        expect((body.result as { token: string }).token).toBe('t');
    });

    it('auth returning Response short-circuits', async () => {
        const h = handleHttp(srv(), { auth: async () => new Response('nope', { status: 401 }) });
        const res = await h(post(rpc('server/discover')));
        expect(res.status).toBe(401);
    });
});

describe('sseResponse cleanup', () => {
    it('releases listener registration on for-await throw', async () => {
        let closed = false;
        const handlers: StatelessHandlers = {
            dispatch: async () => ({ jsonrpc: JSONRPC_VERSION, id: 1, result: {} }),
            listen: () => ({
                stream: (async function* () {
                    yield { jsonrpc: JSONRPC_VERSION, method: 'notifications/subscriptions/acknowledged', params: { notifications: {} } };
                    throw new Error('boom');
                })(),
                close: () => {
                    closed = true;
                }
            })
        };
        const res = await statelessHttpHandler(
            handlers,
            post(rpc('subscriptions/listen', 1, { notifications: {} }), { Accept: 'text/event-stream' })
        );
        // Drain the SSE stream until it errors/ends.
        const reader = res.body!.getReader();
        try {
            for (;;) {
                const { done } = await reader.read();
                if (done) break;
            }
        } catch {
            // expected: source threw
        }
        expect(closed).toBe(true);
    });
});
