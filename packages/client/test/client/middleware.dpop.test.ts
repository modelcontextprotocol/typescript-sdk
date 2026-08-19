import type { FetchLike } from '@modelcontextprotocol/core-internal';
import type { Mock, Mocked, MockedFunction } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OAuthClientProvider } from '../../src/client/auth';
import { DpopSession } from '../../src/client/dpop';

// `auth` is mocked (not exercised for real — it would attempt real network discovery) so the
// "credential retry happens before a nonce challenge is discovered" test below can simulate a
// successful re-authorization without a real OAuth flow. Everything else — importantly
// `adaptOAuthProvider`, which is what makes `withOAuth` DPoP-aware — stays the real implementation.
vi.mock('../../src/client/auth', async () => {
    const actual = await vi.importActual<typeof import('../../src/client/auth')>('../../src/client/auth');
    return { ...actual, auth: vi.fn() };
});

import { auth } from '../../src/client/auth';
import { withDpop, withDpopFromProvider, withOAuth } from '../../src/client/middleware';

const mockAuth = auth as MockedFunction<typeof auth>;

function decodeJwtPart(part: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

describe('withDpop', () => {
    let session: DpopSession;
    let getToken: MockedFunction<() => string | undefined | Promise<string | undefined>>;
    let mockFetch: MockedFunction<FetchLike>;

    beforeEach(async () => {
        session = await DpopSession.create();
        getToken = vi.fn().mockResolvedValue('the-access-token');
        mockFetch = vi.fn();
    });

    it('presents Authorization: DPoP <token> plus a fresh proof bound to the request', async () => {
        mockFetch.mockResolvedValue(new Response(null, { status: 200 }));
        const enhancedFetch = withDpop(session, getToken)(mockFetch);

        await enhancedFetch('https://mcp.example.com/mcp', { method: 'POST' });

        const [, init] = mockFetch.mock.calls[0]!;
        const headers = init!.headers as Headers;
        expect(headers.get('Authorization')).toBe('DPoP the-access-token');
        const proof = headers.get('DPoP');
        expect(proof).toBeTruthy();
        const payload = decodeJwtPart(proof!.split('.')[1]!);
        expect(payload.htm).toBe('POST');
        expect(payload.htu).toBe('https://mcp.example.com/mcp');
        expect(payload.ath).toBeDefined();
    });

    it('defaults to GET when no method is given', async () => {
        mockFetch.mockResolvedValue(new Response(null, { status: 200 }));
        const enhancedFetch = withDpop(session, getToken)(mockFetch);
        await enhancedFetch('https://mcp.example.com/mcp');
        const payload = decodeJwtPart(((mockFetch.mock.calls[0]![1]!.headers as Headers).get('DPoP') as string).split('.')[1]!);
        expect(payload.htm).toBe('GET');
    });

    it('sends no Authorization/DPoP headers when getToken resolves to undefined', async () => {
        getToken.mockResolvedValue(undefined);
        mockFetch.mockResolvedValue(new Response(null, { status: 200 }));
        const enhancedFetch = withDpop(session, getToken)(mockFetch);

        await enhancedFetch('https://mcp.example.com/mcp', { headers: { Accept: 'application/json' } });

        const headers = new Headers(mockFetch.mock.calls[0]![1]!.headers);
        expect(headers.has('Authorization')).toBe(false);
        expect(headers.has('DPoP')).toBe(false);
        expect(headers.get('Accept')).toBe('application/json');
    });

    it('retries once, with a fresh proof carrying the nonce, on a use_dpop_nonce challenge', async () => {
        mockFetch
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 401,
                    headers: { 'WWW-Authenticate': 'DPoP error="use_dpop_nonce"', 'DPoP-Nonce': 'rs-nonce-1' }
                })
            )
            .mockResolvedValueOnce(new Response(null, { status: 200 }));
        const enhancedFetch = withDpop(session, getToken)(mockFetch);

        const response = await enhancedFetch('https://mcp.example.com/mcp', { method: 'POST' });

        expect(response.status).toBe(200);
        expect(mockFetch).toHaveBeenCalledTimes(2);
        const firstProof = mockFetch.mock.calls[0]![1]!.headers as Headers;
        const secondProof = mockFetch.mock.calls[1]![1]!.headers as Headers;
        expect(secondProof.get('DPoP')).not.toBe(firstProof.get('DPoP')); // fresh jti, never resent
        expect(decodeJwtPart((secondProof.get('DPoP') as string).split('.')[1]!).nonce).toBe('rs-nonce-1');
    });

    it('carries a DPoP-Nonce received on a 2xx response in the next request’s proof (RFC 9449 §8.2)', async () => {
        mockFetch
            .mockResolvedValueOnce(new Response(null, { status: 200, headers: { 'DPoP-Nonce': 'rs-nonce-1' } }))
            .mockResolvedValueOnce(new Response(null, { status: 200 }));
        const enhancedFetch = withDpop(session, getToken)(mockFetch);

        await enhancedFetch('https://mcp.example.com/mcp', { method: 'POST' });
        await enhancedFetch('https://mcp.example.com/mcp', { method: 'POST' });

        expect(mockFetch).toHaveBeenCalledTimes(2);
        const secondProof = (mockFetch.mock.calls[1]![1]!.headers as Headers).get('DPoP') as string;
        expect(decodeJwtPart(secondProof.split('.')[1]!).nonce).toBe('rs-nonce-1');
    });

    it('does not retry on an ordinary (non-nonce) 401', async () => {
        mockFetch.mockResolvedValue(new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'DPoP error="invalid_token"' } }));
        const enhancedFetch = withDpop(session, getToken)(mockFetch);

        const response = await enhancedFetch('https://mcp.example.com/mcp');

        expect(response.status).toBe(401);
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('does not retry a use_dpop_nonce challenge that carries no fresh DPoP-Nonce (nothing new to retry with)', async () => {
        session.rememberNonce('https://mcp.example.com/mcp', 'stale-nonce');
        mockFetch.mockResolvedValue(new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'DPoP error="use_dpop_nonce"' } }));
        const enhancedFetch = withDpop(session, getToken)(mockFetch);

        const response = await enhancedFetch('https://mcp.example.com/mcp');

        expect(response.status).toBe(401);
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });
});

describe('withDpop — session/token sources', () => {
    it('passes the request through untouched when the session source resolves to undefined', async () => {
        const mockFetch = vi.fn<FetchLike>().mockResolvedValue(new Response(null, { status: 200 }));
        const init = { method: 'POST', headers: { Authorization: 'Bearer tok' } };

        const noSession = vi.fn<() => Promise<DpopSession | undefined>>().mockResolvedValue(undefined);
        await withDpop(noSession, async () => 'tok')(mockFetch)('https://mcp.example.com/mcp', init);

        expect(mockFetch).toHaveBeenCalledWith('https://mcp.example.com/mcp', init);
    });

    it('leaves an existing Authorization header alone when getToken resolves to undefined', async () => {
        const session = await DpopSession.create();
        const mockFetch = vi.fn<FetchLike>().mockResolvedValue(new Response(null, { status: 200 }));
        const init = { method: 'POST', headers: { Authorization: 'Bearer tok' } };

        const noToken = vi.fn<() => Promise<string | undefined>>().mockResolvedValue(undefined);
        await withDpop(session, noToken)(mockFetch)('https://mcp.example.com/mcp', init);

        expect(mockFetch).toHaveBeenCalledWith('https://mcp.example.com/mcp', init);
    });

    it('accepts a lazily-resolved session', async () => {
        const session = await DpopSession.create();
        const mockFetch = vi.fn<FetchLike>().mockResolvedValue(new Response(null, { status: 200 }));

        await withDpop(
            async () => session,
            async () => 'tok'
        )(mockFetch)('https://mcp.example.com/mcp', { method: 'POST' });

        expect((mockFetch.mock.calls[0]![1]!.headers as Headers).get('Authorization')).toBe('DPoP tok');
    });
});

describe('withDpopFromProvider', () => {
    let session: DpopSession;
    let provider: Mocked<OAuthClientProvider>;
    let mockFetch: MockedFunction<FetchLike>;
    const bearerInit = { method: 'POST', headers: { Authorization: 'Bearer tok-1' } };

    beforeEach(async () => {
        session = await DpopSession.create();
        provider = {
            get redirectUrl() {
                return 'http://localhost/callback';
            },
            get clientMetadata() {
                return { redirect_uris: ['http://localhost/callback'] };
            },
            tokens: vi.fn().mockResolvedValue({ access_token: 'tok-1', token_type: 'DPoP' }),
            saveTokens: vi.fn(),
            clientInformation: vi.fn(),
            redirectToAuthorization: vi.fn(),
            saveCodeVerifier: vi.fn(),
            codeVerifier: vi.fn(),
            dpop: vi.fn().mockResolvedValue(session)
        };
        mockFetch = vi.fn<FetchLike>().mockResolvedValue(new Response(null, { status: 200 }));
    });

    it('upgrades a token_type=DPoP token to the DPoP scheme with a proof bound to the request', async () => {
        await withDpopFromProvider(provider)(mockFetch)('https://mcp.example.com/mcp?x=1', bearerInit);

        const headers = mockFetch.mock.calls[0]![1]!.headers as Headers;
        expect(headers.get('Authorization')).toBe('DPoP tok-1');
        const payload = decodeJwtPart(headers.get('DPoP')!.split('.')[1]!);
        expect(payload).toMatchObject({ htm: 'POST', htu: 'https://mcp.example.com/mcp' });
        expect(payload.ath).toBeDefined();
    });

    it('leaves a token_type=Bearer token on the Bearer scheme with no proof, even though dpop() resolves (RFC 9449 §7.1)', async () => {
        // An AS that ignored the DPoP proof (or does not support DPoP) issues token_type=Bearer;
        // presenting that with the DPoP scheme to a Bearer-only resource server is a guaranteed 401.
        provider.tokens.mockResolvedValue({ access_token: 'tok-1', token_type: 'Bearer' });

        await withDpopFromProvider(provider)(mockFetch)('https://mcp.example.com/mcp', bearerInit);

        expect(mockFetch).toHaveBeenCalledWith('https://mcp.example.com/mcp', bearerInit);
    });

    it('is a pass-through when dpop() resolves to undefined', async () => {
        (provider.dpop as Mock).mockResolvedValue(undefined);

        await withDpopFromProvider(provider)(mockFetch)('https://mcp.example.com/mcp', bearerInit);

        expect(mockFetch).toHaveBeenCalledWith('https://mcp.example.com/mcp', bearerInit);
    });

    it('retries once with the server nonce on a use_dpop_nonce challenge, and not when the challenge carries no fresh DPoP-Nonce', async () => {
        mockFetch
            .mockResolvedValueOnce(
                new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'DPoP error="use_dpop_nonce"', 'DPoP-Nonce': 'n1' } })
            )
            .mockResolvedValueOnce(new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'DPoP error="use_dpop_nonce"' } }));

        const response = await withDpopFromProvider(provider)(mockFetch)('https://mcp.example.com/mcp', bearerInit);

        expect(response.status).toBe(401);
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(decodeJwtPart((mockFetch.mock.calls[1]![1]!.headers as Headers).get('DPoP')!.split('.')[1]!).nonce).toBe('n1');
    });

    it('stamps a throwing tokens()/dpop() as an auth-seam failure (not a network error)', async () => {
        const { isAuthSeamEscape } = await import('../../src/client/authSeam');
        provider.tokens.mockRejectedValue(new Error('storage unavailable'));

        const error = await withDpopFromProvider(provider)(mockFetch)('https://mcp.example.com/mcp', bearerInit).catch(error_ => error_);

        expect(isAuthSeamEscape(error)).toBe(true);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});

describe('withOAuth — DPoP-aware', () => {
    let mockProvider: Mocked<OAuthClientProvider>;
    let mockFetch: MockedFunction<FetchLike>;
    let session: DpopSession;

    beforeEach(async () => {
        session = await DpopSession.create();
        mockProvider = {
            get redirectUrl() {
                return 'http://localhost/callback';
            },
            get clientMetadata() {
                return { redirect_uris: ['http://localhost/callback'] };
            },
            tokens: vi.fn(),
            saveTokens: vi.fn(),
            clientInformation: vi.fn(),
            redirectToAuthorization: vi.fn(),
            saveCodeVerifier: vi.fn(),
            codeVerifier: vi.fn(),
            invalidateCredentials: vi.fn(),
            dpop: vi.fn().mockResolvedValue(session)
        };
        mockFetch = vi.fn();
    });

    it('presents DPoP Authorization + proof (not Bearer) when provider.dpop() resolves to a session', async () => {
        mockProvider.tokens.mockResolvedValue({ access_token: 'tok-1', token_type: 'DPoP' });
        mockFetch.mockResolvedValue(new Response(null, { status: 200 }));
        const enhancedFetch = withOAuth(mockProvider, 'https://mcp.example.com')(mockFetch);

        await enhancedFetch('https://mcp.example.com/mcp', { method: 'POST' });

        const headers = mockFetch.mock.calls[0]![1]!.headers as Headers;
        expect(headers.get('Authorization')).toBe('DPoP tok-1');
        expect(headers.get('DPoP')).toBeTruthy();
    });

    it('keeps presenting plain Bearer when the provider has no dpop() (existing behavior unaffected)', async () => {
        mockProvider.dpop = undefined;
        mockProvider.tokens.mockResolvedValue({ access_token: 'tok-1', token_type: 'Bearer' });
        mockFetch.mockResolvedValue(new Response(null, { status: 200 }));
        const enhancedFetch = withOAuth(mockProvider, 'https://mcp.example.com')(mockFetch);

        await enhancedFetch('https://mcp.example.com/mcp');

        const headers = mockFetch.mock.calls[0]![1]!.headers as Headers;
        expect(headers.get('Authorization')).toBe('Bearer tok-1');
        expect(headers.has('DPoP')).toBe(false);
    });

    it('retries once on a use_dpop_nonce challenge without invoking the auth() re-authorization flow', async () => {
        mockProvider.tokens.mockResolvedValue({ access_token: 'tok-1', token_type: 'DPoP' });
        mockFetch
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 401,
                    headers: { 'WWW-Authenticate': 'DPoP error="use_dpop_nonce"', 'DPoP-Nonce': 'rs-nonce-1' }
                })
            )
            .mockResolvedValueOnce(new Response(null, { status: 200 }));
        const enhancedFetch = withOAuth(mockProvider, 'https://mcp.example.com')(mockFetch);

        const response = await enhancedFetch('https://mcp.example.com/mcp', { method: 'POST' });

        expect(response.status).toBe(200);
        expect(mockFetch).toHaveBeenCalledTimes(2);
        // The nonce leg is a self-contained retry — it never calls provider.saveTokens or any
        // other re-authorization side effect.
        expect(mockProvider.saveTokens).not.toHaveBeenCalled();
    });

    it('completes credential re-authorization first, then a nonce challenge discovered on the retried request (auth/dpop-nonce shape)', async () => {
        // No token yet -> the first 401 carries no DPoP-Nonce header at all, so it is NOT a nonce
        // challenge; only after auth() succeeds and a real token is presented does the resource
        // server reveal its nonce requirement. Regression test for a bug where the nonce check
        // only ran *before* the credential retry, never after it — real conformance servers
        // (auth/dpop-nonce) hit exactly this ordering.
        mockProvider.tokens.mockResolvedValue(undefined);
        mockAuth.mockImplementation(async () => {
            mockProvider.tokens.mockResolvedValue({ access_token: 'tok-1', token_type: 'DPoP' });
            return 'AUTHORIZED';
        });
        mockFetch
            .mockResolvedValueOnce(new Response(null, { status: 401 })) // no token, no nonce header
            .mockResolvedValueOnce(
                new Response(null, {
                    status: 401,
                    headers: { 'WWW-Authenticate': 'DPoP error="use_dpop_nonce"', 'DPoP-Nonce': 'rs-nonce-1' }
                })
            )
            .mockResolvedValueOnce(new Response(null, { status: 200 }));
        const enhancedFetch = withOAuth(mockProvider, 'https://mcp.example.com')(mockFetch);

        const response = await enhancedFetch('https://mcp.example.com/mcp', { method: 'POST' });

        expect(response.status).toBe(200);
        expect(mockFetch).toHaveBeenCalledTimes(3);
        expect(mockAuth).toHaveBeenCalledTimes(1);
    });
});
