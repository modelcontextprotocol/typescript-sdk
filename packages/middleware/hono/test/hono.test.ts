import type { Context } from 'hono';
import { Hono } from 'hono';
import { vi } from 'vitest';

import { createMcpHonoApp } from '../src/hono';
import { hostHeaderValidation } from '../src/middleware/hostHeaderValidation';

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

    test('createMcpHonoApp does not parse a non-JSON media type whose parameters contain application/json', async () => {
        const app = createMcpHonoApp();
        app.post('/echo', (c: Context) => c.json({ parsed: c.get('parsedBody') ?? null }));

        // `text/plain; a=application/json` contains the substring but its media
        // type is text/plain — it must never be treated as a JSON body.
        const res = await app.request('http://localhost/echo', {
            method: 'POST',
            headers: { Host: 'localhost:3000', 'content-type': 'text/plain; a=application/json' },
            body: JSON.stringify({ a: 1 })
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ parsed: null });
    });

    test('createMcpHonoApp parses application/json with parameters', async () => {
        const app = createMcpHonoApp();
        app.post('/echo', (c: Context) => c.json(c.get('parsedBody')));

        const res = await app.request('http://localhost/echo', {
            method: 'POST',
            headers: { Host: 'localhost:3000', 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ a: 1 })
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ a: 1 });
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

    /** A body that yields up to `chunks` 1 MiB chunks on demand (no Content-Length), counting pulls. */
    function streamedBody(chunks: number): { body: ReadableStream<Uint8Array>; pulls: () => number } {
        let pulled = 0;
        const body = new ReadableStream<Uint8Array>(
            {
                pull(controller) {
                    if (pulled >= chunks) {
                        return controller.close();
                    }
                    pulled++;
                    controller.enqueue(new Uint8Array(1024 * 1024).fill(0x20));
                }
            },
            { highWaterMark: 0 }
        );
        return { body, pulls: () => pulled };
    }
    const jsonHeaders = { Host: 'localhost:3000', 'content-type': 'application/json' };

    test('createMcpHonoApp rejects a disallowed Host before reading the body', async () => {
        const app = createMcpHonoApp();
        app.post('/echo', (c: Context) => c.text('ok'));

        const { body, pulls } = streamedBody(1);
        const init = { method: 'POST', headers: { ...jsonHeaders, Host: 'example.com:3000' }, body, duplex: 'half' };
        const res = await app.request('http://localhost/echo', init as RequestInit);
        expect(res.status).toBe(403);
        expect(pulls()).toBe(0);
    });

    test('createMcpHonoApp answers 413 for a JSON body over the size limit', async () => {
        const app = createMcpHonoApp();
        app.post('/echo', (c: Context) => c.text('ok'));

        const declared = streamedBody(5);
        const declaredOverLimit = { ...jsonHeaders, 'content-length': String(4 * 1024 * 1024 + 1) };
        const res = await app.request('http://localhost/echo', {
            method: 'POST',
            headers: declaredOverLimit,
            body: declared.body,
            duplex: 'half'
        } as RequestInit);
        expect(res.status).toBe(413);
        expect(await res.json()).toEqual({
            jsonrpc: '2.0',
            error: { code: -32_000, message: expect.stringMatching(/^Payload Too Large/) },
            id: null
        });
        // clone() tees the body, which buffers one chunk up front; nothing past that is read.
        expect(declared.pulls()).toBeLessThanOrEqual(1);

        const streamed = await app.request('http://localhost/echo', {
            method: 'POST',
            headers: jsonHeaders,
            body: streamedBody(5).body,
            duplex: 'half'
        } as RequestInit);
        expect(streamed.status).toBe(413);
        expect(((await streamed.json()) as { error: { code: number } }).error.code).toBe(-32_000);
    });

    test('createMcpHonoApp maxRequestBodySize moves the pre-parse bound and is validated', async () => {
        const strict = createMcpHonoApp({ maxRequestBodySize: 1024 });
        strict.post('/echo', (c: Context) => c.text('ok'));
        const refused = await strict.request('http://localhost/echo', {
            method: 'POST',
            headers: jsonHeaders,
            body: JSON.stringify({ pad: 'x'.repeat(2048) })
        });
        expect(refused.status).toBe(413);
        expect(((await refused.json()) as { error: { message: string } }).error.message).toMatch(/must not exceed 1024 bytes/);

        const roomy = createMcpHonoApp({ maxRequestBodySize: 8 * 1024 * 1024 });
        roomy.post('/echo', (c: Context) => c.json({ keys: Object.keys(c.get('parsedBody') as object) }));
        const served = await roomy.request('http://localhost/echo', {
            method: 'POST',
            headers: jsonHeaders,
            body: JSON.stringify({ pad: 'x'.repeat(5 * 1024 * 1024) })
        });
        expect(served.status).toBe(200);
        expect(await served.json()).toEqual({ keys: ['pad'] });

        expect(() => createMcpHonoApp({ maxRequestBodySize: 0 })).toThrow(RangeError);
    });
});
