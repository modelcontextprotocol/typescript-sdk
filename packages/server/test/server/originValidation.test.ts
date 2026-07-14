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

    it('denies on failure: unparseable Origin values and the opaque null origin are rejected, never passed through', () => {
        for (const malformed of ['null', 'not a url', 'evil.example.com', 'about:blank']) {
            const result = validateOriginHeader(malformed, localhostAllowedOrigins());
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.errorCode).toBe('invalid_origin_header');
            }
        }
    });

    it('rejects userinfo before an allowed hostname', () => {
        for (const malformed of ['http://user@localhost', 'http://user:pass@localhost']) {
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

    it('returns a 403 response when an Origin with userinfo resolves to an allowed hostname', () => {
        const request = new Request('http://localhost/mcp', { headers: { origin: 'http://user@localhost' } });
        expect(originValidationResponse(request, localhostAllowedOrigins())?.status).toBe(403);
    });
});
