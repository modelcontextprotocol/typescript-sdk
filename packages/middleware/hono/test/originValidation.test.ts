import { Hono } from 'hono';
import { vi } from 'vitest';

import { createMcpHonoApp } from '../src/hono.js';
import { localhostOriginValidation, originValidation } from '../src/middleware/originValidation.js';

describe('@modelcontextprotocol/hono origin validation', () => {
    test('originValidation blocks a disallowed Origin and allows an allowed Origin', async () => {
        const app = new Hono();
        app.use('*', originValidation(['localhost']));
        app.get('/health', c => c.text('ok'));

        const bad = await app.request('http://localhost/health', {
            headers: { Host: 'localhost:3000', Origin: 'http://evil.example.com' }
        });
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

        const good = await app.request('http://localhost/health', { headers: { Host: 'localhost:3000', Origin: 'http://localhost:3000' } });
        expect(good.status).toBe(200);
        expect(await good.text()).toBe('ok');
    });

    test('originValidation allows requests without an Origin header and denies malformed origins', async () => {
        const app = new Hono();
        app.use('*', localhostOriginValidation());
        app.get('/health', c => c.text('ok'));

        const noOrigin = await app.request('http://localhost/health', { headers: { Host: 'localhost:3000' } });
        expect(noOrigin.status).toBe(200);

        const malformed = await app.request('http://localhost/health', { headers: { Host: 'localhost:3000', Origin: 'null' } });
        expect(malformed.status).toBe(403);
    });

    test('createMcpHonoApp arms localhost origin validation by default', async () => {
        const app = createMcpHonoApp();
        app.get('/health', c => c.text('ok'));

        const bad = await app.request('http://localhost/health', {
            headers: { Host: 'localhost:3000', Origin: 'http://evil.example.com' }
        });
        expect(bad.status).toBe(403);

        const goodOrigin = await app.request('http://localhost/health', {
            headers: { Host: 'localhost:3000', Origin: 'http://localhost:5173' }
        });
        expect(goodOrigin.status).toBe(200);

        const noOrigin = await app.request('http://localhost/health', { headers: { Host: 'localhost:3000' } });
        expect(noOrigin.status).toBe(200);
    });

    test('createMcpHonoApp uses allowedOrigins when provided', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const app = createMcpHonoApp({ host: '0.0.0.0', allowedHosts: ['myapp.local'], allowedOrigins: ['myapp.local'] });
        warn.mockRestore();
        app.get('/health', c => c.text('ok'));

        const good = await app.request('http://localhost/health', {
            headers: { Host: 'myapp.local:3000', Origin: 'https://myapp.local' }
        });
        expect(good.status).toBe(200);

        const bad = await app.request('http://localhost/health', {
            headers: { Host: 'myapp.local:3000', Origin: 'http://evil.example.com' }
        });
        expect(bad.status).toBe(403);
    });

    test('createMcpHonoApp applies no origin validation for 0.0.0.0 without allowedOrigins (existing warning preserved)', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const app = createMcpHonoApp({ host: '0.0.0.0' });
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
        app.get('/health', c => c.text('ok'));

        const anyOrigin = await app.request('http://localhost/health', {
            headers: { Host: 'whatever.example.com', Origin: 'http://evil.example.com' }
        });
        expect(anyOrigin.status).toBe(200);
    });
});
