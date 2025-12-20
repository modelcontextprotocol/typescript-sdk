import type { AuthInfo } from '@modelcontextprotocol/core';
import { InsufficientScopeError, InvalidTokenError, ServerError } from '@modelcontextprotocol/core';

import { requireBearerAuth } from '../../../../src/server/auth/middleware/bearerAuth.js';
import type { OAuthTokenVerifier } from '../../../../src/server/auth/provider.js';

describe('requireBearerAuth (web)', () => {
    const verifyAccessToken = vi.fn();
    const verifier: OAuthTokenVerifier = { verifyAccessToken };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns authInfo on success', async () => {
        const info: AuthInfo = {
            token: 't',
            clientId: 'c',
            scopes: ['read'],
            expiresAt: Math.floor(Date.now() / 1000) + 3600
        };
        verifyAccessToken.mockResolvedValue(info);

        const req = new Request('http://localhost/x', { headers: { Authorization: 'Bearer t' } });
        const result = await requireBearerAuth(req, { verifier });

        expect('authInfo' in result).toBe(true);
        if ('authInfo' in result) {
            expect(result.authInfo).toEqual(info);
        }
    });

    it('returns 401 when missing Authorization header', async () => {
        const req = new Request('http://localhost/x');
        const result = await requireBearerAuth(req, { verifier });

        expect('response' in result).toBe(true);
        if ('response' in result) {
            expect(result.response.status).toBe(401);
            expect(result.response.headers.get('www-authenticate')).toContain('Bearer error="invalid_token"');
            expect(await result.response.json()).toEqual(
                expect.objectContaining({ error: 'invalid_token', error_description: 'Missing Authorization header' })
            );
        }
    });

    it('returns 401 when verifier throws InvalidTokenError', async () => {
        verifyAccessToken.mockRejectedValue(new InvalidTokenError('bad'));
        const req = new Request('http://localhost/x', { headers: { Authorization: 'Bearer t' } });
        const result = await requireBearerAuth(req, { verifier });

        expect('response' in result).toBe(true);
        if ('response' in result) {
            expect(result.response.status).toBe(401);
        }
    });

    it('returns 403 when scopes are insufficient', async () => {
        const info: AuthInfo = {
            token: 't',
            clientId: 'c',
            scopes: ['read'],
            expiresAt: Math.floor(Date.now() / 1000) + 3600
        };
        verifyAccessToken.mockResolvedValue(info);

        const req = new Request('http://localhost/x', { headers: { Authorization: 'Bearer t' } });
        const result = await requireBearerAuth(req, { verifier, requiredScopes: ['read', 'write'] });

        expect('response' in result).toBe(true);
        if ('response' in result) {
            expect(result.response.status).toBe(403);
            expect(result.response.headers.get('www-authenticate')).toContain('Bearer error="insufficient_scope"');
            expect(await result.response.json()).toEqual(
                expect.objectContaining({ error: 'insufficient_scope', error_description: 'Insufficient scope' })
            );
        }
    });

    it('returns 500 when verifier throws ServerError', async () => {
        verifyAccessToken.mockRejectedValue(new ServerError('boom'));
        const req = new Request('http://localhost/x', { headers: { Authorization: 'Bearer t' } });
        const result = await requireBearerAuth(req, { verifier });

        expect('response' in result).toBe(true);
        if ('response' in result) {
            expect(result.response.status).toBe(500);
        }
    });

    it('includes scope and resource_metadata in WWW-Authenticate when provided', async () => {
        verifyAccessToken.mockRejectedValue(new InvalidTokenError('bad'));
        const req = new Request('http://localhost/x', { headers: { Authorization: 'Bearer t' } });
        const result = await requireBearerAuth(req, {
            verifier,
            requiredScopes: ['read', 'write'],
            resourceMetadataUrl: 'https://example.com/.well-known/oauth-protected-resource'
        });

        expect('response' in result).toBe(true);
        if ('response' in result) {
            const header = result.response.headers.get('www-authenticate') ?? '';
            expect(header).toContain('scope="read write"');
            expect(header).toContain('resource_metadata="https://example.com/.well-known/oauth-protected-resource"');
        }
    });

    it('passes through InsufficientScopeError from verifier as 403', async () => {
        verifyAccessToken.mockRejectedValue(new InsufficientScopeError('nope'));
        const req = new Request('http://localhost/x', { headers: { Authorization: 'Bearer t' } });
        const result = await requireBearerAuth(req, { verifier });

        expect('response' in result).toBe(true);
        if ('response' in result) {
            expect(result.response.status).toBe(403);
        }
    });
});
