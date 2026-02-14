import Fastify from 'fastify';
import { vi } from 'vitest';

import { createMcpFastifyApp } from '../src/fastify.js';
import { hostHeaderValidation, localhostHostValidation } from '../src/middleware/hostHeaderValidation.js';

describe('@modelcontextprotocol/fastify', () => {
    describe('hostHeaderValidation', () => {
        test('should block invalid Host header', async () => {
            const app = Fastify();
            app.addHook('onRequest', hostHeaderValidation(['localhost']));
            app.get('/health', async () => ({ ok: true }));

            const res = await app.inject({
                method: 'GET',
                url: '/health',
                headers: { host: 'evil.com:3000' }
            });

            expect(res.statusCode).toBe(403);
            expect(res.json()).toEqual(
                expect.objectContaining({
                    jsonrpc: '2.0',
                    error: expect.objectContaining({
                        code: -32_000
                    }),
                    id: null
                })
            );
        });

        test('should allow valid Host header', async () => {
            const app = Fastify();
            app.addHook('onRequest', hostHeaderValidation(['localhost']));
            app.get('/health', async () => 'ok');

            const res = await app.inject({
                method: 'GET',
                url: '/health',
                headers: { host: 'localhost:3000' }
            });

            expect(res.statusCode).toBe(200);
            expect(res.body).toBe('ok');
        });

        test('should handle multiple allowed hostnames', async () => {
            const app = Fastify();
            app.addHook('onRequest', hostHeaderValidation(['localhost', '127.0.0.1', 'myapp.local']));
            app.get('/health', async () => 'ok');

            const res1 = await app.inject({
                method: 'GET',
                url: '/health',
                headers: { host: '127.0.0.1:8080' }
            });
            const res2 = await app.inject({
                method: 'GET',
                url: '/health',
                headers: { host: 'myapp.local' }
            });

            expect(res1.statusCode).toBe(200);
            expect(res2.statusCode).toBe(200);
        });
    });

    describe('localhostHostValidation', () => {
        test('should allow localhost', async () => {
            const app = Fastify();
            app.addHook('onRequest', localhostHostValidation());
            app.get('/health', async () => 'ok');

            const res = await app.inject({
                method: 'GET',
                url: '/health',
                headers: { host: 'localhost:3000' }
            });
            expect(res.statusCode).toBe(200);
        });

        test('should allow 127.0.0.1', async () => {
            const app = Fastify();
            app.addHook('onRequest', localhostHostValidation());
            app.get('/health', async () => 'ok');

            const res = await app.inject({
                method: 'GET',
                url: '/health',
                headers: { host: '127.0.0.1:3000' }
            });
            expect(res.statusCode).toBe(200);
        });

        test('should allow [::1] (IPv6 localhost)', async () => {
            const app = Fastify();
            app.addHook('onRequest', localhostHostValidation());
            app.get('/health', async () => 'ok');

            const res = await app.inject({
                method: 'GET',
                url: '/health',
                headers: { host: '[::1]:3000' }
            });
            expect(res.statusCode).toBe(200);
        });

        test('should block non-localhost hosts', async () => {
            const app = Fastify();
            app.addHook('onRequest', localhostHostValidation());
            app.get('/health', async () => 'ok');

            const res = await app.inject({
                method: 'GET',
                url: '/health',
                headers: { host: 'evil.com:3000' }
            });
            expect(res.statusCode).toBe(403);
        });
    });

    describe('createMcpFastifyApp', () => {
        test('should enable localhost DNS rebinding protection by default', async () => {
            const app = createMcpFastifyApp();
            app.get('/health', async () => 'ok');

            const bad = await app.inject({
                method: 'GET',
                url: '/health',
                headers: { host: 'evil.com:3000' }
            });
            expect(bad.statusCode).toBe(403);

            const good = await app.inject({
                method: 'GET',
                url: '/health',
                headers: { host: 'localhost:3000' }
            });
            expect(good.statusCode).toBe(200);
        });

        test('should apply DNS rebinding protection for localhost host', () => {
            const app = createMcpFastifyApp({ host: 'localhost' });
            expect(app).toBeDefined();
            expect(typeof app.addHook).toBe('function');
            expect(typeof app.get).toBe('function');
            expect(typeof app.post).toBe('function');
        });

        test('should apply DNS rebinding protection for ::1 host', () => {
            const app = createMcpFastifyApp({ host: '::1' });
            expect(app).toBeDefined();
        });

        test('should use allowedHosts when provided', async () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const app = createMcpFastifyApp({ host: '0.0.0.0', allowedHosts: ['myapp.local'] });
            warn.mockRestore();

            app.get('/health', async () => 'ok');

            const bad = await app.inject({
                method: 'GET',
                url: '/health',
                headers: { host: 'evil.com:3000' }
            });
            expect(bad.statusCode).toBe(403);

            const good = await app.inject({
                method: 'GET',
                url: '/health',
                headers: { host: 'myapp.local:3000' }
            });
            expect(good.statusCode).toBe(200);
        });

        test('should warn when binding to 0.0.0.0 without allowedHosts', () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

            createMcpFastifyApp({ host: '0.0.0.0' });

            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining('Warning: Server is binding to 0.0.0.0 without DNS rebinding protection')
            );

            warn.mockRestore();
        });

        test('should warn when binding to :: without allowedHosts', () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

            createMcpFastifyApp({ host: '::' });

            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining('Warning: Server is binding to :: without DNS rebinding protection')
            );

            warn.mockRestore();
        });

        test('should not warn for 0.0.0.0 when allowedHosts is provided', () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

            createMcpFastifyApp({ host: '0.0.0.0', allowedHosts: ['myapp.local'] });

            expect(warn).not.toHaveBeenCalled();

            warn.mockRestore();
        });

        test('should not apply host validation for 0.0.0.0 without allowedHosts', async () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const app = createMcpFastifyApp({ host: '0.0.0.0' });
            warn.mockRestore();

            app.get('/health', async () => 'ok');

            const res = await app.inject({
                method: 'GET',
                url: '/health',
                headers: { host: 'evil.com:3000' }
            });
            expect(res.statusCode).toBe(200);
        });

        test('should not apply host validation for non-localhost hosts without allowedHosts', () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

            const app = createMcpFastifyApp({ host: '192.168.1.1' });

            expect(warn).not.toHaveBeenCalled();
            expect(app).toBeDefined();

            warn.mockRestore();
        });
    });
});
