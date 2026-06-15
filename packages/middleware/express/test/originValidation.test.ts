import type { NextFunction, Request, Response } from 'express';
import { vi } from 'vitest';

import { createMcpExpressApp } from '../src/express.js';
import { localhostOriginValidation, originValidation } from '../src/middleware/originValidation.js';

// Helper to create mock Express request/response/next
function createMockReqResNext(origin?: string) {
    const req = {
        headers: {
            origin
        }
    } as Request;

    const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis()
    } as unknown as Response;

    const next = vi.fn() as NextFunction;

    return { req, res, next };
}

describe('@modelcontextprotocol/express origin validation', () => {
    describe('originValidation', () => {
        test('should block a disallowed Origin header', () => {
            const middleware = originValidation(['localhost']);
            const { req, res, next } = createMockReqResNext('http://evil.example.com');

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

        test('should allow an allowed Origin header (port-agnostic)', () => {
            const middleware = originValidation(['localhost']);
            const { req, res, next } = createMockReqResNext('http://localhost:3000');

            middleware(req, res, next);

            expect(res.status).not.toHaveBeenCalled();
            expect(next).toHaveBeenCalled();
        });

        test('should allow requests without an Origin header (non-browser clients)', () => {
            const middleware = originValidation(['localhost']);
            const { req, res, next } = createMockReqResNext(undefined);

            middleware(req, res, next);

            expect(res.status).not.toHaveBeenCalled();
            expect(next).toHaveBeenCalled();
        });

        test('should deny on failure: malformed and null origins are rejected, never passed through', () => {
            const middleware = originValidation(['localhost']);
            for (const malformed of ['null', 'not a url']) {
                const { req, res, next } = createMockReqResNext(malformed);
                middleware(req, res, next);
                expect(res.status).toHaveBeenCalledWith(403);
                expect(next).not.toHaveBeenCalled();
            }
        });

        test('localhostOriginValidation allows the localhost family only', () => {
            const middleware = localhostOriginValidation();

            const allowed = createMockReqResNext('http://127.0.0.1:8080');
            middleware(allowed.req, allowed.res, allowed.next);
            expect(allowed.next).toHaveBeenCalled();

            const blocked = createMockReqResNext('http://localhost.evil.example.com');
            middleware(blocked.req, blocked.res, blocked.next);
            expect(blocked.res.status).toHaveBeenCalledWith(403);
            expect(blocked.next).not.toHaveBeenCalled();
        });
    });

    describe('createMcpExpressApp origin arming', () => {
        test('builds an app with default localhost origin protection', () => {
            const app = createMcpExpressApp();
            expect(app).toBeDefined();
            expect(typeof app.use).toBe('function');
        });

        test('accepts an allowedOrigins override without warnings', () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const app = createMcpExpressApp({ host: '0.0.0.0', allowedHosts: ['myapp.local'], allowedOrigins: ['myapp.local'] });
            expect(app).toBeDefined();
            expect(warn).not.toHaveBeenCalled();
            warn.mockRestore();
        });

        test('keeps the existing 0.0.0.0 warning untouched when no allowlists are provided', () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

            createMcpExpressApp({ host: '0.0.0.0' });

            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn).toHaveBeenCalledWith(
                expect.stringContaining('Warning: Server is binding to 0.0.0.0 without DNS rebinding protection')
            );

            warn.mockRestore();
        });
    });
});
