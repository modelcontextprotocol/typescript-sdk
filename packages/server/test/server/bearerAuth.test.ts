import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/core-internal';
import type { AuthInfo } from '@modelcontextprotocol/core-internal';
import { describe, expect, it, vi } from 'vitest';

import type { OAuthTokenVerifier } from '../../src/server/middleware/bearerAuth';
import { bearerAuthChallengeResponse, requireBearerAuth, verifyBearerToken } from '../../src/server/middleware/bearerAuth';

const validAuthInfo: AuthInfo = {
    token: 'valid-token',
    clientId: 'client-123',
    scopes: ['read', 'write'],
    expiresAt: Date.now() / 1000 + 3600
};

function verifierReturning(authInfo: AuthInfo): OAuthTokenVerifier {
    return { verifyAccessToken: vi.fn().mockResolvedValue(authInfo) };
}

function verifierThrowing(error: unknown): OAuthTokenVerifier {
    return { verifyAccessToken: vi.fn().mockRejectedValue(error) };
}

describe('verifyBearerToken', () => {
    it('returns the verifier AuthInfo for a valid token', async () => {
        const verifier = verifierReturning(validAuthInfo);
        const authInfo = await verifyBearerToken('Bearer valid-token', { verifier });
        expect(authInfo).toEqual(validAuthInfo);
        expect(verifier.verifyAccessToken).toHaveBeenCalledWith('valid-token');
    });

    it('accepts a case-insensitive Bearer scheme', async () => {
        const verifier = verifierReturning(validAuthInfo);
        await expect(verifyBearerToken('bEaReR valid-token', { verifier })).resolves.toEqual(validAuthInfo);
    });

    it('rejects a missing Authorization header with invalid_token', async () => {
        await expect(verifyBearerToken(undefined, { verifier: verifierReturning(validAuthInfo) })).rejects.toMatchObject({
            code: OAuthErrorCode.InvalidToken,
            message: 'Missing Authorization header'
        });
        await expect(verifyBearerToken(null, { verifier: verifierReturning(validAuthInfo) })).rejects.toMatchObject({
            code: OAuthErrorCode.InvalidToken
        });
    });

    it('rejects a non-Bearer or empty-token header as a format error', async () => {
        const verifier = verifierReturning(validAuthInfo);
        for (const header of ['Basic dXNlcjpwYXNz', 'Bearer', 'Bearer ']) {
            await expect(verifyBearerToken(header, { verifier })).rejects.toMatchObject({
                code: OAuthErrorCode.InvalidToken,
                message: "Invalid Authorization header format, expected 'Bearer TOKEN'"
            });
        }
        expect(verifier.verifyAccessToken).not.toHaveBeenCalled();
    });

    it('propagates the verifier OAuthError untouched', async () => {
        const verifier = verifierThrowing(new OAuthError(OAuthErrorCode.InvalidToken, 'unknown token'));
        await expect(verifyBearerToken('Bearer nope', { verifier })).rejects.toMatchObject({
            code: OAuthErrorCode.InvalidToken,
            message: 'unknown token'
        });
    });

    it('enforces requiredScopes before expiry (matching the Express middleware order)', async () => {
        // Expired AND missing a scope: the scope failure wins, as it always has.
        const verifier = verifierReturning({ ...validAuthInfo, scopes: ['read'], expiresAt: Date.now() / 1000 - 100 });
        await expect(verifyBearerToken('Bearer t', { verifier, requiredScopes: ['read', 'write'] })).rejects.toMatchObject({
            code: OAuthErrorCode.InsufficientScope,
            message: 'Insufficient scope'
        });
    });

    it('rejects a token without an expiration time', async () => {
        const { expiresAt: _dropped, ...withoutExpiry } = validAuthInfo;
        const verifier = verifierReturning(withoutExpiry as AuthInfo);
        await expect(verifyBearerToken('Bearer t', { verifier })).rejects.toMatchObject({
            code: OAuthErrorCode.InvalidToken,
            message: 'Token has no expiration time'
        });
        const nanVerifier = verifierReturning({ ...validAuthInfo, expiresAt: Number.NaN });
        await expect(verifyBearerToken('Bearer t', { verifier: nanVerifier })).rejects.toMatchObject({
            code: OAuthErrorCode.InvalidToken,
            message: 'Token has no expiration time'
        });
    });

    it('rejects an expired token', async () => {
        const verifier = verifierReturning({ ...validAuthInfo, expiresAt: Date.now() / 1000 - 100 });
        await expect(verifyBearerToken('Bearer t', { verifier })).rejects.toMatchObject({
            code: OAuthErrorCode.InvalidToken,
            message: 'Token has expired'
        });
    });
});

describe('verifyBearerToken with expectedResource', () => {
    const expectedResource = new URL('https://api.example.com/mcp');
    const notIssuedForThisResource = { code: OAuthErrorCode.InvalidToken, message: 'Token was not issued for this resource' };

    function verifierReporting(resource: string | undefined): OAuthTokenVerifier {
        return verifierReturning(resource === undefined ? validAuthInfo : { ...validAuthInfo, resource: new URL(resource) });
    }

    it('compares AuthInfo.resource only when expectedResource is set', async () => {
        const verifier = verifierReporting('https://other.example.com/mcp');
        await expect(verifyBearerToken('Bearer t', { verifier })).resolves.toMatchObject({ token: 'valid-token' });
        await expect(verifyBearerToken('Bearer t', { verifier, expectedResource })).rejects.toMatchObject(notIssuedForThisResource);
    });

    it('rejects a token without a reported resource only when expectedResource is set', async () => {
        const verifier = verifierReporting(undefined);
        await expect(verifyBearerToken('Bearer t', { verifier })).resolves.toEqual(validAuthInfo);
        await expect(verifyBearerToken('Bearer t', { verifier, expectedResource })).rejects.toMatchObject(notIssuedForThisResource);
    });

    it('accepts a token reported for expectedResource, one trailing slash aside on either value', async () => {
        for (const [reported, expected] of [
            ['https://api.example.com/mcp', 'https://api.example.com/mcp'],
            ['https://api.example.com/mcp/', 'https://api.example.com/mcp'],
            ['https://api.example.com/mcp', 'https://api.example.com/mcp/'],
            ['HTTPS://API.example.com:443/mcp', 'https://api.example.com/mcp']
        ] as const) {
            const options = { verifier: verifierReporting(reported), expectedResource: new URL(expected) };
            await expect(verifyBearerToken('Bearer t', options)).resolves.toMatchObject({ token: 'valid-token' });
        }
        const twoSlashes = { verifier: verifierReporting('https://api.example.com/mcp//'), expectedResource };
        await expect(verifyBearerToken('Bearer t', twoSlashes)).rejects.toMatchObject(notIssuedForThisResource);
    });

    it.each([
        'https://other.example.com/mcp',
        'http://api.example.com/mcp',
        'https://api.example.com:8443/mcp',
        'https://api.example.com/',
        'https://api.example.com/mcp/tools',
        'https://api.example.com/mcp?tenant=a'
    ])('rejects a token reported for %s', async resource => {
        const verifier = verifierReporting(resource);
        await expect(verifyBearerToken('Bearer t', { verifier, expectedResource })).rejects.toMatchObject(notIssuedForThisResource);
    });

    it('rejects a token reported for another resource before checking scopes', async () => {
        const verifier = verifierReturning({ ...validAuthInfo, scopes: [], resource: new URL('https://other.example.com/mcp') });
        await expect(verifyBearerToken('Bearer t', { verifier, requiredScopes: ['read'], expectedResource })).rejects.toMatchObject(
            notIssuedForThisResource
        );
    });

    it('compares an identifier that is not an http URL the same way', async () => {
        const identifier = new URL('api://0b5e1c2a-notes');
        await expect(
            verifyBearerToken('Bearer t', { verifier: verifierReporting('api://0b5e1c2a-notes'), expectedResource: identifier })
        ).resolves.toMatchObject({ token: 'valid-token' });
        await expect(
            verifyBearerToken('Bearer t', { verifier: verifierReporting('api://0b5e1c2a-other'), expectedResource: identifier })
        ).rejects.toMatchObject(notIssuedForThisResource);
    });
});

describe('bearerAuthChallengeResponse', () => {
    it('answers 401 invalid_token with the WWW-Authenticate challenge, resource_metadata last', async () => {
        const response = bearerAuthChallengeResponse(new OAuthError(OAuthErrorCode.InvalidToken, 'Token has expired'), {
            requiredScopes: ['read', 'write'],
            resourceMetadataUrl: 'https://api.example.com/.well-known/oauth-protected-resource'
        });
        expect(response.status).toBe(401);
        expect(response.headers.get('WWW-Authenticate')).toMatch(
            /^Bearer error="invalid_token", error_description="Token has expired", scope="read write", resource_metadata="https:\/\/api\.example\.com\/\.well-known\/oauth-protected-resource"$/
        );
        expect(await response.json()).toMatchObject({ error: 'invalid_token', error_description: 'Token has expired' });
    });

    it('answers 403 insufficient_scope with the configured scopes in the challenge', async () => {
        const response = bearerAuthChallengeResponse(new OAuthError(OAuthErrorCode.InsufficientScope, 'Insufficient scope'), {
            requiredScopes: ['read', 'write']
        });
        expect(response.status).toBe(403);
        expect(response.headers.get('WWW-Authenticate')).toContain('scope="read write"');
        expect(await response.json()).toMatchObject({ error: 'insufficient_scope' });
    });

    it('answers 500 server_error without a challenge', async () => {
        const response = bearerAuthChallengeResponse(new OAuthError(OAuthErrorCode.ServerError, 'boom'));
        expect(response.status).toBe(500);
        expect(response.headers.get('WWW-Authenticate')).toBeNull();
    });

    it('answers 400 without a challenge for any other OAuth error code', async () => {
        const response = bearerAuthChallengeResponse(new OAuthError(OAuthErrorCode.InvalidRequest, 'nope'));
        expect(response.status).toBe(400);
        expect(response.headers.get('WWW-Authenticate')).toBeNull();
        expect(await response.json()).toMatchObject({ error: 'invalid_request' });
    });

    it('answers 500 server_error for a non-OAuthError value', async () => {
        const response = bearerAuthChallengeResponse(new Error('boom'));
        expect(response.status).toBe(500);
        expect(response.headers.get('WWW-Authenticate')).toBeNull();
        expect(await response.json()).toMatchObject({ error: 'server_error', error_description: 'Internal Server Error' });
    });
});

describe('requireBearerAuth (web-standard)', () => {
    it('resolves to AuthInfo for a valid request', async () => {
        const gate = requireBearerAuth({ verifier: verifierReturning(validAuthInfo) });
        const result = await gate(new Request('https://api.example.com/mcp', { headers: { authorization: 'Bearer valid-token' } }));
        expect(result).toEqual(validAuthInfo);
    });

    it('resolves to the challenge Response for a missing header', async () => {
        const gate = requireBearerAuth({
            verifier: verifierReturning(validAuthInfo),
            resourceMetadataUrl: 'https://api.example.com/.well-known/oauth-protected-resource'
        });
        const result = await gate(new Request('https://api.example.com/mcp'));
        expect(result).toBeInstanceOf(Response);
        const response = result as Response;
        expect(response.status).toBe(401);
        expect(response.headers.get('WWW-Authenticate')).toMatch(/resource_metadata="https:\/\/api\.example\.com/);
    });

    it('resolves to a 403 Response when scopes are missing', async () => {
        const gate = requireBearerAuth({
            verifier: verifierReturning({ ...validAuthInfo, scopes: ['read'] }),
            requiredScopes: ['read', 'write']
        });
        const result = await gate(new Request('https://api.example.com/mcp', { headers: { authorization: 'Bearer t' } }));
        expect((result as Response).status).toBe(403);
    });

    it('passes expectedResource through to the token check', async () => {
        const expectedResource = new URL('https://api.example.com/mcp');
        const request = () => new Request('https://api.example.com/mcp', { headers: { authorization: 'Bearer t' } });

        const sameResource = { ...validAuthInfo, resource: new URL('https://api.example.com/mcp') };
        expect(await requireBearerAuth({ verifier: verifierReturning(sameResource), expectedResource })(request())).toEqual(sameResource);

        const otherResource = { ...validAuthInfo, resource: new URL('https://other.example.com/mcp') };
        const result = await requireBearerAuth({ verifier: verifierReturning(otherResource), expectedResource })(request());
        expect(result).toBeInstanceOf(Response);
        const response = result as Response;
        expect(response.status).toBe(401);
        expect(response.headers.get('WWW-Authenticate')).toBe(
            'Bearer error="invalid_token", error_description="Token was not issued for this resource"'
        );
        expect(await response.json()).toEqual({ error: 'invalid_token', error_description: 'Token was not issued for this resource' });
    });
});

describe('hardening (review findings)', () => {
    it('returns the challenge Response instead of throwing for a non-ASCII verifier message', async () => {
        const response = bearerAuthChallengeResponse(new OAuthError(OAuthErrorCode.InvalidToken, 'token invalide \u2026'));
        expect(response.status).toBe(401);
        expect(response.headers.get('WWW-Authenticate')).toContain('error_description="token invalide  "');
    });

    it('escapes quotes and strips CR/LF in the challenge header', async () => {
        const response = bearerAuthChallengeResponse(new OAuthError(OAuthErrorCode.InvalidToken, 'bad "token"\r\nnext'));
        const challenge = response.headers.get('WWW-Authenticate') ?? '';
        expect(challenge).toContain('error_description="bad \\"token\\"  next"');
    });

    it('resolves (not rejects) when the verifier throws a hostile-message OAuthError', async () => {
        const gate = requireBearerAuth({
            verifier: {
                verifyAccessToken: vi.fn().mockRejectedValue(new OAuthError(OAuthErrorCode.InvalidToken, 'upstream:\nfail \u2026'))
            }
        });
        const result = await gate(new Request('https://api.example.com/mcp', { headers: { authorization: 'Bearer x' } }));
        expect(result).toBeInstanceOf(Response);
        expect((result as Response).status).toBe(401);
    });

    it('verifies the first token when duplicate Authorization headers are comma-joined', async () => {
        const verifier = verifierReturning(validAuthInfo);
        const gate = requireBearerAuth({ verifier });
        const headers = new Headers();
        headers.append('authorization', 'Bearer valid-token');
        headers.append('authorization', 'Bearer second-token');
        const result = await gate(new Request('https://api.example.com/mcp', { headers }));
        expect(result).toEqual(validAuthInfo);
        expect(verifier.verifyAccessToken).toHaveBeenCalledWith('valid-token');
    });

    it('throws at creation time for missing options', () => {
        expect(() => requireBearerAuth(undefined as never)).toThrow(TypeError);
    });
});
