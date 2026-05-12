import type { NextFunction, Request, Response } from 'express';
import supertest from 'supertest';
import { vi } from 'vitest';

import { McpServer, SessionCompat } from '@modelcontextprotocol/server';

import { createMcpExpressApp, mcpExpressHandler } from '../src/express.js';
import { hostHeaderValidation, localhostHostValidation } from '../src/middleware/hostHeaderValidation.js';

const INIT_MESSAGE = {
    jsonrpc: '2.0',
    method: 'initialize',
    params: { clientInfo: { name: 'test-client', version: '1.0' }, protocolVersion: '2025-11-25', capabilities: {} },
    id: 'init-1'
};

// Helper to create mock Express request/response/next
function createMockReqResNext(host?: string) {
    const req = {
        headers: {
            host
        }
    } as Request;

    const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis()
    } as unknown as Response;

    const next = vi.fn() as NextFunction;

    return { req, res, next };
}

describe('@modelcontextprotocol/express', () => {
    describe('hostHeaderValidation', () => {
        test('should block invalid Host header', () => {
            const middleware = hostHeaderValidation(['localhost']);
            const { req, res, next } = createMockReqResNext('evil.com:3000');

            middleware(req, res, next);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({
                    jsonrpc: '2.0',
                    error: expect.objectContaining({
                        code: -32_000
                    }),
                    id: null
                })
            );
            expect(next).not.toHaveBeenCalled();
        });

        test('should allow valid Host header', () => {
            const middleware = hostHeaderValidation(['localhost']);
            const { req, res, next } = createMockReqResNext('localhost:3000');

            middleware(req, res, next);

            expect(res.status).not.toHaveBeenCalled();
            expect(res.json).not.toHaveBeenCalled();
            expect(next).toHaveBeenCalled();
        });

        test('should handle multiple allowed hostnames', () => {
            const middleware = hostHeaderValidation(['localhost', '127.0.0.1', 'myapp.local']);
            const { req: req1, res: res1, next: next1 } = createMockReqResNext('127.0.0.1:8080');
            const { req: req2, res: res2, next: next2 } = createMockReqResNext('myapp.local');

            middleware(req1, res1, next1);
            middleware(req2, res2, next2);

            expect(next1).toHaveBeenCalled();
            expect(next2).toHaveBeenCalled();
        });
    });

    describe('localhostHostValidation', () => {
        test('should allow localhost', () => {
            const middleware = localhostHostValidation();
            const { req, res, next } = createMockReqResNext('localhost:3000');

            middleware(req, res, next);

            expect(next).toHaveBeenCalled();
        });

        test('should allow 127.0.0.1', () => {
            const middleware = localhostHostValidation();
            const { req, res, next } = createMockReqResNext('127.0.0.1:3000');

            middleware(req, res, next);

            expect(next).toHaveBeenCalled();
        });

        test('should allow [::1] (IPv6 localhost)', () => {
            const middleware = localhostHostValidation();
            const { req, res, next } = createMockReqResNext('[::1]:3000');

            middleware(req, res, next);

            expect(next).toHaveBeenCalled();
        });

        test('should block non-localhost hosts', () => {
            const middleware = localhostHostValidation();
            const { req, res, next } = createMockReqResNext('evil.com:3000');

            middleware(req, res, next);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(next).not.toHaveBeenCalled();
        });
    });

    describe('createMcpExpressApp', () => {
        test('should enable localhost DNS rebinding protection by default', () => {
            const app = createMcpExpressApp();

            // The app should be a valid Express application
            expect(app).toBeDefined();
            expect(typeof app.use).toBe('function');
            expect(typeof app.get).toBe('function');
            expect(typeof app.post).toBe('function');
        });

        test('should apply DNS rebinding protection for localhost host', () => {
            const app = createMcpExpressApp({ host: 'localhost' });
            expect(app).toBeDefined();
        });

        test('should apply DNS rebinding protection for ::1 host', () => {
            const app = createMcpExpressApp({ host: '::1' });
            expect(app).toBeDefined();
        });

        test('should use allowedHosts when provided', () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const app = createMcpExpressApp({ host: '0.0.0.0', allowedHosts: ['myapp.local'] });
            warn.mockRestore();

            expect(app).toBeDefined();
        });

        test('should warn when binding to 0.0.0.0 without allowedHosts', () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

            createMcpExpressApp({ host: '0.0.0.0' });

            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining('Warning: Server is binding to 0.0.0.0 without DNS rebinding protection')
            );

            warn.mockRestore();
        });

        test('should warn when binding to :: without allowedHosts', () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

            createMcpExpressApp({ host: '::' });

            expect(warn).toHaveBeenCalledWith(expect.stringContaining('Warning: Server is binding to :: without DNS rebinding protection'));

            warn.mockRestore();
        });

        test('should not warn for 0.0.0.0 when allowedHosts is provided', () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

            createMcpExpressApp({ host: '0.0.0.0', allowedHosts: ['myapp.local'] });

            expect(warn).not.toHaveBeenCalled();

            warn.mockRestore();
        });

        test('should not apply host validation for non-localhost hosts without allowedHosts', () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

            // For arbitrary hosts (not 0.0.0.0 or ::), no validation is applied and no warning
            const app = createMcpExpressApp({ host: '192.168.1.1' });

            expect(warn).not.toHaveBeenCalled();
            expect(app).toBeDefined();

            warn.mockRestore();
        });

        test('should accept jsonLimit option', () => {
            const app = createMcpExpressApp({ jsonLimit: '10mb' });
            expect(app).toBeDefined();
        });

        test('should work without jsonLimit option', () => {
            const app = createMcpExpressApp();
            expect(app).toBeDefined();
        });
    });

    describe('mcpExpressHandler', () => {
        function makeApp(options?: Parameters<typeof mcpExpressHandler>[1]) {
            const mcp = new McpServer({ name: 'test-server', version: '1.0.0' });
            const app = createMcpExpressApp({ host: '0.0.0.0', allowedHosts: ['127.0.0.1'] });
            app.all('/mcp', mcpExpressHandler(mcp, { enableJsonResponse: true, ...options }));
            return app;
        }

        test('serves initialize via mcp.dispatch() (stateless, no transport class)', async () => {
            const res = await supertest(makeApp())
                .post('/mcp')
                .set('Accept', 'application/json, text/event-stream')
                .set('Host', '127.0.0.1')
                .send(INIT_MESSAGE);
            expect(res.status).toBe(200);
            expect(res.body.result).toMatchObject({ serverInfo: { name: 'test-server' } });
            expect(res.headers['mcp-session-id']).toBeUndefined();
        });

        test('serves session lifecycle via SessionCompat', async () => {
            const app = makeApp({ session: new SessionCompat() });
            const initRes = await supertest(app)
                .post('/mcp')
                .set('Accept', 'application/json, text/event-stream')
                .set('Host', '127.0.0.1')
                .send(INIT_MESSAGE);
            const sid = initRes.headers['mcp-session-id'] as string;
            expect(sid).toBeTruthy();
            const pingRes = await supertest(app)
                .post('/mcp')
                .set('Accept', 'application/json, text/event-stream')
                .set('Host', '127.0.0.1')
                .set('mcp-session-id', sid)
                .set('mcp-protocol-version', '2025-11-25')
                .send({ jsonrpc: '2.0', method: 'ping', params: {}, id: 'p-1' });
            expect(pingRes.status).toBe(200);
            expect(pingRes.body).toMatchObject({ jsonrpc: '2.0', id: 'p-1', result: {} });
        });
    });
});
