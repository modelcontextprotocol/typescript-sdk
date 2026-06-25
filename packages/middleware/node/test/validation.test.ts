import type { IncomingMessage, ServerResponse } from 'node:http';

import { vi } from 'vitest';

import { hostHeaderValidation, localhostHostValidation } from '../src/middleware/hostHeaderValidation';
import { localhostOriginValidation, originValidation } from '../src/middleware/originValidation';

function fakeReqRes(headers: Record<string, string | undefined>) {
    const req = { headers } as unknown as IncomingMessage;
    const writeHead = vi.fn().mockReturnThis();
    const end = vi.fn().mockReturnThis();
    const res = { writeHead, end } as unknown as ServerResponse;
    return { req, res, writeHead, end };
}

function sentBody(end: ReturnType<typeof vi.fn>): unknown {
    const payload = end.mock.calls[0]?.[0] as string | undefined;
    return payload === undefined ? undefined : JSON.parse(payload);
}

describe('@modelcontextprotocol/node validation guards', () => {
    describe('hostHeaderValidation', () => {
        test('blocks a disallowed Host header with a 403 JSON-RPC error and reports the request as handled', () => {
            const guard = hostHeaderValidation(['localhost']);
            const { req, res, writeHead, end } = fakeReqRes({ host: 'evil.example.com:3000' });

            expect(guard(req, res)).toBe(false);
            expect(writeHead).toHaveBeenCalledWith(403, { 'Content-Type': 'application/json' });
            expect(sentBody(end)).toEqual(
                expect.objectContaining({
                    jsonrpc: '2.0',
                    error: expect.objectContaining({ code: -32_000 }),
                    id: null
                })
            );
        });

        test('allows an allowed Host header (port-agnostic)', () => {
            const guard = localhostHostValidation();
            const { req, res, writeHead } = fakeReqRes({ host: '127.0.0.1:8080' });

            expect(guard(req, res)).toBe(true);
            expect(writeHead).not.toHaveBeenCalled();
        });
    });

    describe('originValidation', () => {
        test('blocks a disallowed Origin header with a 403 JSON-RPC error', () => {
            const guard = originValidation(['localhost']);
            const { req, res, writeHead, end } = fakeReqRes({ host: 'localhost:3000', origin: 'http://evil.example.com' });

            expect(guard(req, res)).toBe(false);
            expect(writeHead).toHaveBeenCalledWith(403, { 'Content-Type': 'application/json' });
            expect(sentBody(end)).toEqual(
                expect.objectContaining({
                    jsonrpc: '2.0',
                    error: expect.objectContaining({ code: -32_000 }),
                    id: null
                })
            );
        });

        test('allows an allowed Origin and requests without an Origin header', () => {
            const guard = localhostOriginValidation();

            const allowed = fakeReqRes({ host: 'localhost:3000', origin: 'http://localhost:5173' });
            expect(guard(allowed.req, allowed.res)).toBe(true);

            const absent = fakeReqRes({ host: 'localhost:3000' });
            expect(guard(absent.req, absent.res)).toBe(true);
        });

        test('denies malformed Origin values (deny on failure)', () => {
            const guard = localhostOriginValidation();
            const { req, res } = fakeReqRes({ host: 'localhost:3000', origin: 'null' });
            expect(guard(req, res)).toBe(false);
        });
    });
});
