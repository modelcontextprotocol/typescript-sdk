/**
 * Framework-agnostic Origin validation helpers: allowlist matching, the
 * absent-header pass, and the deny-on-failure behavior for malformed values.
 */
import { describe, expect, it } from 'vitest';

import { localhostAllowedOrigins, originValidationResponse, validateOriginHeader } from '../../src/server/middleware/originValidation';

describe('validateOriginHeader', () => {
    it('passes when no Origin header is present (non-browser clients)', () => {
        expect(validateOriginHeader(undefined, ['localhost']).ok).toBe(true);
        expect(validateOriginHeader(null, ['localhost']).ok).toBe(true);
        expect(validateOriginHeader('', ['localhost']).ok).toBe(true);
    });

    it('allows origins whose hostname is on the allowlist, port- and scheme-agnostic', () => {
        expect(validateOriginHeader('http://localhost:3000', ['localhost']).ok).toBe(true);
        expect(validateOriginHeader('https://localhost', ['localhost']).ok).toBe(true);
        expect(validateOriginHeader('http://127.0.0.1:8080', localhostAllowedOrigins()).ok).toBe(true);
        expect(validateOriginHeader('http://[::1]:8080', localhostAllowedOrigins()).ok).toBe(true);
    });

    it('rejects origins whose hostname is not on the allowlist', () => {
        const result = validateOriginHeader('http://evil.example.com', localhostAllowedOrigins());
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.errorCode).toBe('invalid_origin');
            expect(result.message).toContain('evil.example.com');
        }
    });

    it('rejects lookalike subdomains of allowed hostnames', () => {
        expect(validateOriginHeader('http://localhost.evil.example.com', localhostAllowedOrigins()).ok).toBe(false);
    });

    it('allows one browser extension when its ID is listed', () => {
        const allowed = ['abcdefghijklmnopabcdefghijklmnop'];
        expect(validateOriginHeader('chrome-extension://abcdefghijklmnopabcdefghijklmnop', allowed).ok).toBe(true);
        expect(validateOriginHeader('chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba', allowed).ok).toBe(false);
    });

    it('allows every origin of a scheme listed as `<scheme>://*`', () => {
        const allowed = ['myapp.local', 'chrome-extension://*'];
        expect(validateOriginHeader('chrome-extension://abcdefghijklmnopabcdefghijklmnop', allowed).ok).toBe(true);
        expect(validateOriginHeader('moz-extension://0a1b2c3d-0000-4000-8000-000000000000', allowed).ok).toBe(false);
        expect(validateOriginHeader('https://evil.example.com', allowed).ok).toBe(false);
        expect(validateOriginHeader('https://chrome-extension', allowed).ok).toBe(false);
        expect(validateOriginHeader('null', allowed).ok).toBe(false);
    });

    it('does not honour `http://*` or `https://*`: websites are listed by hostname', () => {
        const allowed = ['http://*', 'https://*', 'myapp.local'];
        expect(validateOriginHeader('https://evil.example.com', allowed).ok).toBe(false);
        expect(validateOriginHeader('http://evil.example.com', allowed).ok).toBe(false);
        expect(validateOriginHeader('https://myapp.local', allowed).ok).toBe(true);
    });

    it('localhostAllowedOrigins rejects browser-extension origins unless their scheme is added', () => {
        const extension = 'moz-extension://0a1b2c3d-0000-4000-8000-000000000000';
        expect(validateOriginHeader(extension, localhostAllowedOrigins()).ok).toBe(false);
        expect(validateOriginHeader(extension, [...localhostAllowedOrigins(), 'moz-extension://*']).ok).toBe(true);
    });

    it('denies on failure: unparseable Origin values and the opaque null origin are rejected, never passed through', () => {
        for (const malformed of ['null', 'not a url', 'evil.example.com', 'about:blank']) {
            const result = validateOriginHeader(malformed, localhostAllowedOrigins());
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.errorCode).toBe('invalid_origin_header');
            }
        }
    });
});

describe('originValidationResponse', () => {
    it('returns undefined for allowed and absent origins', () => {
        const allowed = new Request('http://localhost/mcp', { headers: { origin: 'http://localhost:3000' } });
        expect(originValidationResponse(allowed, localhostAllowedOrigins())).toBeUndefined();

        const absent = new Request('http://localhost/mcp');
        expect(originValidationResponse(absent, localhostAllowedOrigins())).toBeUndefined();
    });

    it('returns a 403 JSON-RPC error response for disallowed origins', async () => {
        const request = new Request('http://localhost/mcp', { headers: { origin: 'http://evil.example.com' } });
        const response = originValidationResponse(request, localhostAllowedOrigins());
        expect(response).toBeDefined();
        expect(response!.status).toBe(403);
        const body = (await response!.json()) as { jsonrpc: string; error: { code: number; message: string }; id: unknown };
        expect(body.jsonrpc).toBe('2.0');
        expect(body.error.code).toBe(-32_000);
        expect(body.error.message).toContain('Invalid Origin');
        expect(body.id).toBeNull();
    });
});
