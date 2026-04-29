import type { NextFunction, Request, Response } from 'express';
import { vi } from 'vitest';

import { createMcpExpressApp } from '../src/express.js';
import { hostHeaderValidation, localhostHostValidation } from '../src/middleware/hostHeaderValidation.js';

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
            const app = createMcpExpressApp({ host: '0.0.0.0', allowedHosts: ['myapp.local'] });

            expect(app).toBeDefined();
        });

        test('should not apply host validation for non-localhost hosts without allowedHosts', () => {
            // For arbitrary hosts (not 0.0.0.0 or ::), no validation is applied
            const app = createMcpExpressApp({ host: '192.168.1.1' });

            expect(app).toBeDefined();
        });

        test('should skip host header validation when skipHostHeaderValidation is true', () => {
            // HTTP-level verification is in integration tests (test/integration/test/server.test.ts)
            const app = createMcpExpressApp({ host: '127.0.0.1', skipHostHeaderValidation: true });
            expect(app).toBeDefined();
        });

        test('should skip host header validation for 0.0.0.0 when skipHostHeaderValidation is true', () => {
            const app = createMcpExpressApp({ host: '0.0.0.0', skipHostHeaderValidation: true });
            expect(app).toBeDefined();
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
});
