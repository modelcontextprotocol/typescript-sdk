import Fastify from 'fastify';

import { createMcpFastifyApp } from '../src/fastify';
import { localhostOriginValidation, originValidation } from '../src/middleware/originValidation';

describe('@modelcontextprotocol/fastify origin validation', () => {
    describe('originValidation', () => {
        test('should block a disallowed Origin header', async () => {
            const app = Fastify();
            app.addHook('onRequest', originValidation(['localhost']));
            app.get('/health', async () => ({ ok: true }));

            const res = await app.inject({
                method: 'GET',
                url: '/health',
                headers: { host: 'localhost:3000', origin: 'http://evil.example.com' }
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

        test('should allow an allowed Origin header and requests without an Origin header', async () => {
            const app = Fastify();
            app.addHook('onRequest', localhostOriginValidation());
            app.get('/health', async () => 'ok');

            const allowed = await app.inject({
                method: 'GET',
                url: '/health',
                headers: { host: 'localhost:3000', origin: 'http://localhost:5173' }
            });
            expect(allowed.statusCode).toBe(200);

            const noOrigin = await app.inject({
                method: 'GET',
                url: '/health',
                headers: { host: 'localhost:3000' }
            });
            expect(noOrigin.statusCode).toBe(200);
        });

        test('should deny malformed Origin values (deny on failure)', async () => {
            const app = Fastify();
            app.addHook('onRequest', localhostOriginValidation());
            app.get('/health', async () => 'ok');

            const res = await app.inject({
                method: 'GET',
                url: '/health',
                headers: { host: 'localhost:3000', origin: 'null' }
            });
            expect(res.statusCode).toBe(403);
        });
    });

    describe('createMcpFastifyApp origin arming', () => {
        test('arms localhost origin validation by default', async () => {
            const app = createMcpFastifyApp();
            app.get('/health', async () => 'ok');

            const bad = await app.inject({
                method: 'GET',
                url: '/health',
                headers: { host: 'localhost:3000', origin: 'http://evil.example.com' }
            });
            expect(bad.statusCode).toBe(403);

            const good = await app.inject({
                method: 'GET',
                url: '/health',
                headers: { host: 'localhost:3000', origin: 'http://localhost:5173' }
            });
            expect(good.statusCode).toBe(200);
        });

        test('uses allowedOrigins when provided', async () => {
            const app = createMcpFastifyApp({ host: '0.0.0.0', allowedHosts: ['myapp.local'], allowedOrigins: ['myapp.local'] });
            app.get('/health', async () => 'ok');

            const good = await app.inject({
                method: 'GET',
                url: '/health',
                headers: { host: 'myapp.local:3000', origin: 'https://myapp.local' }
            });
            expect(good.statusCode).toBe(200);

            const bad = await app.inject({
                method: 'GET',
                url: '/health',
                headers: { host: 'myapp.local:3000', origin: 'http://evil.example.com' }
            });
            expect(bad.statusCode).toBe(403);
        });

        test('applies no origin validation for 0.0.0.0 without allowedOrigins', async () => {
            const app = createMcpFastifyApp({ host: '0.0.0.0' });
            app.get('/health', async () => 'ok');

            const res = await app.inject({
                method: 'GET',
                url: '/health',
                headers: { host: 'whatever.example.com', origin: 'http://evil.example.com' }
            });
            expect(res.statusCode).toBe(200);
        });
    });
});
