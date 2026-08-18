import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OAuthClientProvider } from '../../src/client/auth';
import { adaptOAuthProvider, executeTokenRequest, extractWWWAuthenticateParams } from '../../src/client/auth';
import { DpopSession } from '../../src/client/dpop';

function decodeJwtPart(part: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

describe('adaptOAuthProvider — DPoP', () => {
    let session: DpopSession;
    let provider: OAuthClientProvider;

    beforeEach(async () => {
        session = await DpopSession.create();
        provider = {
            get redirectUrl() {
                return 'http://localhost/callback';
            },
            get clientMetadata() {
                return { redirect_uris: ['http://localhost/callback'] };
            },
            clientInformation: vi.fn(),
            tokens: vi.fn(),
            saveTokens: vi.fn(),
            redirectToAuthorization: vi.fn(),
            saveCodeVerifier: vi.fn(),
            codeVerifier: vi.fn(),
            dpop: vi.fn().mockResolvedValue(session)
        };
    });

    it('presents the token with the DPoP scheme plus a matching proof when dpop() resolves', async () => {
        (provider.tokens as Mock).mockResolvedValue({ access_token: 'tok-1', token_type: 'DPoP' });
        const authProvider = adaptOAuthProvider(provider);

        const url = new URL('https://mcp.example.com/mcp');
        const headers = await authProvider.authorizeRequest?.({ method: 'POST', url });

        expect(headers?.Authorization).toBe('DPoP tok-1');
        expect(typeof headers?.DPoP).toBe('string');
        const payload = decodeJwtPart(headers!.DPoP!.split('.')[1]!);
        expect(payload.htm).toBe('POST');
        expect(payload.htu).toBe('https://mcp.example.com/mcp');
        expect(payload.ath).toBeDefined();
    });

    it('falls back to plain Bearer when the provider has no dpop() (back-compat)', async () => {
        provider.dpop = undefined;
        (provider.tokens as Mock).mockResolvedValue({ access_token: 'tok-1', token_type: 'Bearer' });
        const authProvider = adaptOAuthProvider(provider);

        const headers = await authProvider.authorizeRequest?.({ method: 'POST', url: new URL('https://mcp.example.com/mcp') });
        expect(headers).toEqual({ Authorization: 'Bearer tok-1' });
    });

    it('falls back to plain Bearer when dpop() resolves to undefined', async () => {
        (provider.dpop as Mock).mockResolvedValue(undefined);
        (provider.tokens as Mock).mockResolvedValue({ access_token: 'tok-1', token_type: 'Bearer' });
        const authProvider = adaptOAuthProvider(provider);

        const headers = await authProvider.authorizeRequest?.({ method: 'POST', url: new URL('https://mcp.example.com/mcp') });
        expect(headers).toEqual({ Authorization: 'Bearer tok-1' });
    });

    it('returns undefined (no headers) when there is no token yet', async () => {
        (provider.tokens as Mock).mockResolvedValue(undefined);
        const authProvider = adaptOAuthProvider(provider);
        const headers = await authProvider.authorizeRequest?.({ method: 'POST', url: new URL('https://mcp.example.com/mcp') });
        expect(headers).toBeUndefined();
    });

    it('consumeChallenge remembers the nonce and reports retry-worthy only for a genuine use_dpop_nonce challenge', async () => {
        const authProvider = adaptOAuthProvider(provider);
        const url = new URL('https://mcp.example.com/mcp');

        const challenge = new Response(null, {
            status: 401,
            headers: { 'WWW-Authenticate': 'DPoP error="use_dpop_nonce"', 'DPoP-Nonce': 'server-nonce-1' }
        });
        const shouldRetry = await authProvider.consumeChallenge?.(challenge, { method: 'POST', url });
        expect(shouldRetry).toBe(true);
        expect(session.nonceFor(url)).toBe('server-nonce-1');
    });

    it('consumeChallenge returns false for an ordinary invalid_dpop_proof 401 (not a nonce challenge)', async () => {
        const authProvider = adaptOAuthProvider(provider);
        const url = new URL('https://mcp.example.com/mcp');
        const challenge = new Response(null, {
            status: 401,
            headers: { 'WWW-Authenticate': 'DPoP error="invalid_dpop_proof"', 'DPoP-Nonce': 'server-nonce-1' }
        });
        await expect(authProvider.consumeChallenge?.(challenge, { method: 'POST', url })).resolves.toBe(false);
    });

    it('consumeChallenge returns false when the provider has no dpop() session', async () => {
        provider.dpop = undefined;
        const authProvider = adaptOAuthProvider(provider);
        const challenge = new Response(null, {
            status: 401,
            headers: { 'WWW-Authenticate': 'DPoP error="use_dpop_nonce"', 'DPoP-Nonce': 'x' }
        });
        await expect(
            authProvider.consumeChallenge?.(challenge, { method: 'POST', url: new URL('https://mcp.example.com/mcp') })
        ).resolves.toBe(false);
    });
});

describe('executeTokenRequest — DPoP', () => {
    let session: DpopSession;
    let fetchFn: Mock;

    beforeEach(async () => {
        session = await DpopSession.create();
        fetchFn = vi.fn();
    });

    it('signs a DPoP proof into the token request DPoP header', async () => {
        fetchFn.mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({ access_token: 'tok', token_type: 'DPoP' })
        });

        await executeTokenRequest('https://as.example.com', {
            tokenRequestParams: new URLSearchParams({ grant_type: 'client_credentials' }),
            dpop: session,
            fetchFn
        });

        const [, init] = fetchFn.mock.calls[0]!;
        const headers = init.headers as Headers;
        const proof = headers.get('DPoP');
        expect(proof).toBeTruthy();
        const payload = decodeJwtPart(proof!.split('.')[1]!);
        expect(payload.htm).toBe('POST');
        expect(payload.htu).toBe('https://as.example.com/token');
        // No `ath`: the token request presents credentials to *obtain* a token, not an existing one.
        expect(payload.ath).toBeUndefined();
    });

    it('retries once with a fresh nonce-carrying proof on a 400 use_dpop_nonce challenge', async () => {
        fetchFn
            .mockResolvedValueOnce({
                ok: false,
                status: 400,
                headers: new Headers({ 'DPoP-Nonce': 'as-nonce-1' }),
                clone() {
                    return this;
                },
                json: async () => ({ error: 'use_dpop_nonce' })
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                headers: new Headers(),
                json: async () => ({ access_token: 'tok', token_type: 'DPoP' })
            });

        const tokens = await executeTokenRequest('https://as.example.com', {
            tokenRequestParams: new URLSearchParams({ grant_type: 'client_credentials' }),
            dpop: session,
            fetchFn
        });

        expect(tokens.access_token).toBe('tok');
        expect(fetchFn).toHaveBeenCalledTimes(2);
        const secondProof = (fetchFn.mock.calls[1]![1].headers as Headers).get('DPoP');
        const firstProof = (fetchFn.mock.calls[0]![1].headers as Headers).get('DPoP');
        expect(secondProof).not.toBe(firstProof); // fresh jti — never resend the identical proof
        expect(decodeJwtPart(secondProof!.split('.')[1]!).nonce).toBe('as-nonce-1');
        // The session also remembers the nonce for future requests to this origin.
        expect(session.nonceFor('https://as.example.com')).toBe('as-nonce-1');
    });

    it('does not retry a second time (surfaces the error) when the nonce challenge repeats', async () => {
        // A real Response (not a plain mock object): parseErrorResponse — reached once the single
        // retry is exhausted and the challenge repeats — branches on `instanceof Response`.
        fetchFn.mockImplementation(async () =>
            Response.json(
                { error: 'use_dpop_nonce' },
                {
                    status: 400,
                    headers: { 'DPoP-Nonce': 'as-nonce-1' }
                }
            )
        );

        await expect(
            executeTokenRequest('https://as.example.com', {
                tokenRequestParams: new URLSearchParams({ grant_type: 'client_credentials' }),
                dpop: session,
                fetchFn
            })
        ).rejects.toMatchObject({ code: 'use_dpop_nonce' });
        // Exactly one retry: the initial nonce-less attempt, and one retry carrying the nonce.
        expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('is unaffected when no dpop session is supplied (plain OAuth token requests keep working)', async () => {
        fetchFn.mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: async () => ({ access_token: 'tok', token_type: 'Bearer' })
        });

        await executeTokenRequest('https://as.example.com', {
            tokenRequestParams: new URLSearchParams({ grant_type: 'client_credentials' }),
            fetchFn
        });

        const [, init] = fetchFn.mock.calls[0]!;
        expect((init.headers as Headers).has('DPoP')).toBe(false);
    });
});

describe('extractWWWAuthenticateParams — DPoP scheme', () => {
    it('extracts resource_metadata from a DPoP challenge (not just Bearer)', () => {
        const response = new Response(null, {
            headers: {
                'WWW-Authenticate':
                    'DPoP error="invalid_token", resource_metadata="https://example.com/.well-known/oauth-protected-resource"'
            }
        });
        const { resourceMetadataUrl, error } = extractWWWAuthenticateParams(response);
        expect(resourceMetadataUrl?.toString()).toBe('https://example.com/.well-known/oauth-protected-resource');
        expect(error).toBe('invalid_token');
    });

    it('extracts scope from a DPoP insufficient_scope challenge (SEP-2350 step-up for DPoP resources)', () => {
        const response = new Response(null, {
            headers: { 'WWW-Authenticate': 'DPoP error="insufficient_scope", scope="admin"' }
        });
        expect(extractWWWAuthenticateParams(response).scope).toBe('admin');
    });

    it('still returns {} for an unrecognized scheme', () => {
        const response = new Response(null, { headers: { 'WWW-Authenticate': 'Digest realm="x"' } });
        expect(extractWWWAuthenticateParams(response)).toEqual({});
    });
});
