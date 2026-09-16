import { describe, expect, it } from 'vitest';

import {
    hostHeaderValidationResponse,
    localhostAllowedHostnames,
    validateHostHeader
} from '../../src/server/middleware/hostHeaderValidation';

describe('validateHostHeader', () => {
    it('allows hostnames with ports, including IPv4 and bracketed IPv6', () => {
        expect(validateHostHeader('localhost:3000', localhostAllowedHostnames()).ok).toBe(true);
        expect(validateHostHeader('127.0.0.1:8080', localhostAllowedHostnames()).ok).toBe(true);
        expect(validateHostHeader('[::1]:8080', localhostAllowedHostnames()).ok).toBe(true);
    });

    it('rejects userinfo before an allowed hostname', () => {
        for (const malformed of ['@localhost:3000', ':@localhost:3000', 'user@localhost:3000', 'user:pass@localhost:3000']) {
            const result = validateHostHeader(malformed, localhostAllowedHostnames());
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.errorCode).toBe('invalid_host_header');
            }
        }
    });
});

describe('hostHeaderValidationResponse', () => {
    it('returns a 403 response when a Host with userinfo resolves to an allowed hostname', () => {
        const request = new Request('http://localhost/mcp', { headers: { host: '@localhost:3000' } });
        expect(hostHeaderValidationResponse(request, localhostAllowedHostnames())?.status).toBe(403);
    });
});
