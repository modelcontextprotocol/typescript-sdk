import { describe, expect, it } from 'vitest';

import type { RequestEnv, JSONRPCMessage, JSONRPCNotification, JSONRPCRequest } from '@modelcontextprotocol/core';

import { SessionCompat } from '../../src/server/sessionCompat.js';
import type { ShttpCallbacks } from '../../src/server/shttpHandler.js';
import { shttpHandler } from '../../src/server/shttpHandler.js';

/** Minimal in-test callback bundle: maps method name → result, with optional pre-yield notification. */
function fakeServer(
    handlers: Record<string, (req: JSONRPCRequest) => unknown>,
    opts: { preNotify?: JSONRPCNotification } = {}
): ShttpCallbacks {
    return {
        async *onrequest(req: JSONRPCRequest, _env?: RequestEnv): AsyncIterable<JSONRPCMessage> {
            if (opts.preNotify) yield opts.preNotify;
            const h = handlers[req.method];
            if (!h) {
                yield { jsonrpc: '2.0', id: req.id, error: { code: -32_601, message: 'Method not found' } };
                return;
            }
            yield { jsonrpc: '2.0', id: req.id, result: h(req) as Record<string, unknown> };
        },
        async onnotification(_n: JSONRPCNotification): Promise<void> {
            return;
        }
    };
}

const ACCEPT_BOTH = 'application/json, text/event-stream';

function post(body: unknown, headers: Record<string, string> = {}): Request {
    return new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: ACCEPT_BOTH, ...headers },
        body: JSON.stringify(body)
    });
}

const initialize = (id: number | string = 1): JSONRPCRequest => ({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', clientInfo: { name: 't', version: '1' }, capabilities: {} }
});

const toolsList = (id: number | string = 1): JSONRPCRequest => ({ jsonrpc: '2.0', id, method: 'tools/list', params: {} });

async function readSSE(res: Response): Promise<JSONRPCMessage[]> {
    const text = await res.text();
    const out: JSONRPCMessage[] = [];
    for (const block of text.split('\n\n')) {
        const dataLine = block.split('\n').find(l => l.startsWith('data: '));
        if (!dataLine) continue;
        const payload = dataLine.slice('data: '.length);
        if (payload.trim() === '') continue;
        out.push(JSON.parse(payload));
    }
    return out;
}

describe('shttpHandler — stateless', () => {
    const server = fakeServer({
        'tools/list': () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }),
        initialize: () => ({ protocolVersion: '2025-11-25', serverInfo: { name: 's', version: '1' }, capabilities: {} })
    });

    it('POST → SSE response with one result event', async () => {
        const handler = shttpHandler(server);
        const res = await handler(post(toolsList()));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('text/event-stream');
        const msgs = await readSSE(res);
        expect(msgs).toHaveLength(1);
        expect(msgs[0]).toMatchObject({ id: 1, result: { tools: [{ name: 'echo' }] } });
    });

    it('POST with enableJsonResponse → application/json body', async () => {
        const handler = shttpHandler(server, { enableJsonResponse: true });
        const res = await handler(post(toolsList()));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('application/json');
        const body = await res.json();
        expect(body).toMatchObject({ id: 1, result: { tools: expect.any(Array) } });
    });

    it('POST batch → SSE with one response per request, in order', async () => {
        const handler = shttpHandler(server);
        const res = await handler(post([toolsList(1), toolsList(2)]));
        const msgs = await readSSE(res);
        expect(msgs.map(m => (m as { id: number }).id)).toEqual([1, 2]);
    });

    it('POST notification only → 202', async () => {
        const handler = shttpHandler(server);
        const res = await handler(post({ jsonrpc: '2.0', method: 'notifications/initialized' }));
        expect(res.status).toBe(202);
    });

    it('handler-yielded notification precedes the response in SSE', async () => {
        const progress: JSONRPCNotification = {
            jsonrpc: '2.0',
            method: 'notifications/progress',
            params: { progressToken: 1, progress: 0.5 }
        };
        const s = fakeServer({ 'tools/list': () => ({ tools: [] }) }, { preNotify: progress });
        const handler = shttpHandler(s);
        const msgs = await readSSE(await handler(post(toolsList())));
        expect(msgs).toHaveLength(2);
        expect((msgs[0] as JSONRPCNotification).method).toBe('notifications/progress');
        expect(msgs[1]).toMatchObject({ id: 1, result: { tools: [] } });
    });

    it('bad Content-Type → 415', async () => {
        const handler = shttpHandler(server);
        const req = new Request('http://localhost/mcp', {
            method: 'POST',
            headers: { 'content-type': 'text/plain', accept: ACCEPT_BOTH },
            body: '{}'
        });
        expect((await handler(req)).status).toBe(415);
    });

    it('Accept missing text/event-stream → 406', async () => {
        const handler = shttpHandler(server);
        const req = new Request('http://localhost/mcp', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(toolsList())
        });
        expect((await handler(req)).status).toBe(406);
    });

    it('invalid JSON body → 400 with code -32700', async () => {
        const handler = shttpHandler(server);
        const req = new Request('http://localhost/mcp', {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: ACCEPT_BOTH },
            body: '{not json'
        });
        const res = await handler(req);
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: number } };
        expect(body.error.code).toBe(-32_700);
    });

    it('unsupported HTTP method → 405', async () => {
        const handler = shttpHandler(server);
        const res = await handler(new Request('http://localhost/mcp', { method: 'PUT' }));
        expect(res.status).toBe(405);
    });

    it('unsupported mcp-protocol-version header → 400', async () => {
        const handler = shttpHandler(server);
        const res = await handler(post(toolsList(), { 'mcp-protocol-version': '1999-01-01' }));
        expect(res.status).toBe(400);
    });

    it('GET without session compat → 405', async () => {
        const handler = shttpHandler(server);
        const res = await handler(new Request('http://localhost/mcp', { method: 'GET', headers: { accept: 'text/event-stream' } }));
        expect(res.status).toBe(405);
    });

    it('DELETE without session compat → 405', async () => {
        const handler = shttpHandler(server);
        const res = await handler(new Request('http://localhost/mcp', { method: 'DELETE' }));
        expect(res.status).toBe(405);
    });
});

describe('shttpHandler — with SessionCompat', () => {
    const server = fakeServer({
        initialize: () => ({ protocolVersion: '2025-11-25', serverInfo: { name: 's', version: '1' }, capabilities: {} }),
        'tools/list': () => ({ tools: [] })
    });

    it('initialize mints a session and returns mcp-session-id header', async () => {
        const session = new SessionCompat();
        const handler = shttpHandler(server, { session, enableJsonResponse: true });
        const res = await handler(post(initialize()));
        expect(res.status).toBe(200);
        const sid = res.headers.get('mcp-session-id');
        expect(sid).toBeTruthy();
        expect(session.size).toBe(1);
    });

    it('non-initialize without mcp-session-id → 400', async () => {
        const session = new SessionCompat();
        const handler = shttpHandler(server, { session });
        const res = await handler(post(toolsList()));
        expect(res.status).toBe(400);
    });

    it('wrong mcp-session-id → 404', async () => {
        const session = new SessionCompat();
        const handler = shttpHandler(server, { session });
        await handler(post(initialize()));
        const res = await handler(post(toolsList(), { 'mcp-session-id': 'nope' }));
        expect(res.status).toBe(404);
    });

    it('correct mcp-session-id → 200', async () => {
        const session = new SessionCompat();
        const handler = shttpHandler(server, { session, enableJsonResponse: true });
        const initRes = await handler(post(initialize()));
        const sid = initRes.headers.get('mcp-session-id')!;
        const res = await handler(post(toolsList(), { 'mcp-session-id': sid, 'mcp-protocol-version': '2025-11-25' }));
        expect(res.status).toBe(200);
    });

    it('DELETE removes the session', async () => {
        const session = new SessionCompat();
        const handler = shttpHandler(server, { session });
        const initRes = await handler(post(initialize()));
        const sid = initRes.headers.get('mcp-session-id')!;
        const del = await handler(
            new Request('http://localhost/mcp', {
                method: 'DELETE',
                headers: { 'mcp-session-id': sid, 'mcp-protocol-version': '2025-11-25' }
            })
        );
        expect(del.status).toBe(200);
        expect(session.size).toBe(0);
    });

    it('rejects initialize with 503 + Retry-After when at maxSessions', async () => {
        const session = new SessionCompat({ maxSessions: 1, idleTtlMs: 60_000 });
        const handler = shttpHandler(server, { session, enableJsonResponse: true });
        const r1 = await handler(post(initialize(1)));
        expect(r1.status).toBe(200);
        const r2 = await handler(post(initialize(2)));
        // maxSessions=1 + idleTtlMs=60s: first session is fresh so LRU eviction frees nothing → cap hit.
        // (SessionCompat evicts the oldest before rejecting; with a single fresh session that oldest IS evicted,
        // so cap is only actually hit when eviction can't make room. Use maxSessions=0 to force.)
        // Re-test with maxSessions=0 to assert the 503 path deterministically.
        const session0 = new SessionCompat({ maxSessions: 0 });
        const handler0 = shttpHandler(server, { session: session0, enableJsonResponse: true });
        const r0 = await handler0(post(initialize()));
        expect(r0.status).toBe(503);
        expect(r0.headers.get('retry-after')).toBeTruthy();
        // r2 above will have evicted r1's session and succeeded; assert that behavior too.
        expect(r2.status).toBe(200);
        expect(session.size).toBe(1);
    });
});
