import type { Context } from 'hono';
import { Hono } from 'hono';

import { createMcpHonoApp } from '../src/hono.js';
import { hostHeaderValidation } from '../src/middleware/hostHeaderValidation.js';

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
        const app = createMcpHonoApp({ host: '0.0.0.0', allowedHosts: ['myapp.local'] });

        app.get('/health', c => c.text('ok'));

        const bad = await app.request('http://localhost/health', { headers: { Host: 'evil.com:3000' } });
        expect(bad.status).toBe(403);

        const good = await app.request('http://localhost/health', { headers: { Host: 'myapp.local:3000' } });
        expect(good.status).toBe(200);
    });

    test('createMcpHonoApp does not apply host validation for 0.0.0.0 without allowedHosts', async () => {
        const app = createMcpHonoApp({ host: '0.0.0.0' });

        app.get('/health', c => c.text('ok'));

        const res = await app.request('http://localhost/health', { headers: { Host: 'evil.com:3000' } });
        expect(res.status).toBe(200);
    });

    test('createMcpHonoApp skips all host validation when skipHostHeaderValidation is true', async () => {
        const app = createMcpHonoApp({ host: '127.0.0.1', skipHostHeaderValidation: true });

        app.get('/health', c => c.text('ok'));

        // Would normally be blocked by localhost validation, but skipHostHeaderValidation disables it
        const res = await app.request('http://localhost/health', { headers: { Host: 'evil.com:3000' } });
        expect(res.status).toBe(200);
    });

    test('createMcpHonoApp skips validation for 0.0.0.0 when skipHostHeaderValidation is true', async () => {
        const app = createMcpHonoApp({ host: '0.0.0.0', skipHostHeaderValidation: true });

        app.get('/health', c => c.text('ok'));

        const res = await app.request('http://localhost/health', { headers: { Host: 'anything.com:3000' } });
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
});
