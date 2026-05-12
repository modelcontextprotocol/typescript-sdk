import type { Context } from 'hono';
import { Hono } from 'hono';
import { vi } from 'vitest';

import { McpServer, SessionCompat } from '@modelcontextprotocol/server';

import { createMcpHonoApp, mcpHonoHandler } from '../src/hono.js';
import { hostHeaderValidation } from '../src/middleware/hostHeaderValidation.js';

const INIT_MESSAGE = {
    jsonrpc: '2.0',
    method: 'initialize',
    params: { clientInfo: { name: 'test-client', version: '1.0' }, protocolVersion: '2025-11-25', capabilities: {} },
    id: 'init-1'
};

describe('@modelcontextprotocol/hono', () => {
    test('hostHeaderValidation blocks invalid Host and allows valid Host', async () => {
        const app = new Hono();
        app.use('*', hostHeaderValidation(['localhost']));
        app.get('/health', c => c.text('ok'));

        const bad = await app.request('http://localhost/health', { headers: { Host: 'evil.com:3000' } });
        expect(bad.status).toBe(403);
        expect(await bad.json()).toEqual(
            expect.objectContaining({
                jsonrpc: '2.0',
                error: expect.objectContaining({
                    code: -32_000
                }),
                id: null
            })
        );

        const good = await app.request('http://localhost/health', { headers: { Host: 'localhost:3000' } });
        expect(good.status).toBe(200);
        expect(await good.text()).toBe('ok');
    });

    test('createMcpHonoApp enables localhost DNS rebinding protection by default', async () => {
        const app = createMcpHonoApp();
        app.get('/health', c => c.text('ok'));

        const bad = await app.request('http://localhost/health', { headers: { Host: 'evil.com:3000' } });
        expect(bad.status).toBe(403);

        const good = await app.request('http://localhost/health', { headers: { Host: 'localhost:3000' } });
        expect(good.status).toBe(200);
    });

    test('createMcpHonoApp uses allowedHosts when provided (even when binding to 0.0.0.0)', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const app = createMcpHonoApp({ host: '0.0.0.0', allowedHosts: ['myapp.local'] });
        warn.mockRestore();

        app.get('/health', c => c.text('ok'));

        const bad = await app.request('http://localhost/health', { headers: { Host: 'evil.com:3000' } });
        expect(bad.status).toBe(403);

        const good = await app.request('http://localhost/health', { headers: { Host: 'myapp.local:3000' } });
        expect(good.status).toBe(200);
    });

    test('createMcpHonoApp does not apply host validation for 0.0.0.0 without allowedHosts', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const app = createMcpHonoApp({ host: '0.0.0.0' });
        warn.mockRestore();

        app.get('/health', c => c.text('ok'));

        const res = await app.request('http://localhost/health', { headers: { Host: 'evil.com:3000' } });
        expect(res.status).toBe(200);
    });

    test('createMcpHonoApp parses JSON bodies into parsedBody (express.json()-like)', async () => {
        const app = createMcpHonoApp();
        app.post('/echo', (c: Context) => c.json(c.get('parsedBody')));

        const res = await app.request('http://localhost/echo', {
            method: 'POST',
            headers: { Host: 'localhost:3000', 'content-type': 'application/json' },
            body: JSON.stringify({ a: 1 })
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ a: 1 });
    });

    test('createMcpHonoApp returns 400 on invalid JSON', async () => {
        const app = createMcpHonoApp();
        app.post('/echo', (c: Context) => c.text('ok'));

        const res = await app.request('http://localhost/echo', {
            method: 'POST',
            headers: { Host: 'localhost:3000', 'content-type': 'application/json' },
            body: '{"a":'
        });
        expect(res.status).toBe(400);
        expect(await res.text()).toBe('Invalid JSON');
    });

    test('createMcpHonoApp does not override parsedBody if upstream middleware set it', async () => {
        const app = createMcpHonoApp();
        app.use('/echo', async (c: Context, next) => {
            c.set('parsedBody', { preset: true });
            return await next();
        });
        app.post('/echo', (c: Context) => c.json(c.get('parsedBody')));

        const res = await app.request('http://localhost/echo', {
            method: 'POST',
            headers: { Host: 'localhost:3000', 'content-type': 'application/json' },
            body: JSON.stringify({ a: 1 })
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ preset: true });
    });

    describe('mcpHonoHandler', () => {
        function makeApp(options?: Parameters<typeof mcpHonoHandler>[1]) {
            const mcp = new McpServer({ name: 'test-server', version: '1.0.0' });
            const app = createMcpHonoApp({ host: '0.0.0.0', allowedHosts: ['localhost'] });
            app.all('/mcp', mcpHonoHandler(mcp, { enableJsonResponse: true, ...options }));
            return app;
        }

        async function postJson(app: Hono, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
            return app.request('http://localhost/mcp', {
                method: 'POST',
                headers: {
                    Host: 'localhost',
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                    ...headers
                },
                body: JSON.stringify(body)
            });
        }

        test('serves initialize via mcp.dispatch() (stateless, no transport class)', async () => {
            const res = await postJson(makeApp(), INIT_MESSAGE);
            expect(res.status).toBe(200);
            const body = (await res.json()) as { result: { serverInfo: { name: string } } };
            expect(body.result).toMatchObject({ serverInfo: { name: 'test-server' } });
            expect(res.headers.get('mcp-session-id')).toBeNull();
        });

        test('serves session lifecycle via SessionCompat', async () => {
            const app = makeApp({ session: new SessionCompat() });
            const initRes = await postJson(app, INIT_MESSAGE);
            const sid = initRes.headers.get('mcp-session-id');
            expect(sid).toBeTruthy();
            const pingRes = await postJson(
                app,
                { jsonrpc: '2.0', method: 'ping', params: {}, id: 'p-1' },
                { 'mcp-session-id': sid as string, 'mcp-protocol-version': '2025-11-25' }
            );
            expect(pingRes.status).toBe(200);
            expect(await pingRes.json()).toMatchObject({ jsonrpc: '2.0', id: 'p-1', result: {} });
        });
    });
});
